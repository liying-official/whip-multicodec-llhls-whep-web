package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"time"

	"github.com/pion/rtp"
	pwebrtc "github.com/pion/webrtc/v4"

	"github.com/bluenviron/mediamtx/internal/logger"
	"github.com/bluenviron/mediamtx/internal/protocols/webrtc"
	"github.com/bluenviron/mediamtx/internal/protocols/whip"
)

const (
	maxFragmentSize = 1200
	videoSSRC       = 0x10203040
	audioSSRC       = 0x50607080
)

type quietLogger struct{}

func (quietLogger) Log(logger.Level, string, ...any) {}

func mustURL(raw string) *url.URL {
	value, err := url.Parse(raw)
	if err != nil {
		panic(err)
	}
	return value
}

func readIVF(path string) ([][]byte, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	reader := bytes.NewReader(data)
	header := make([]byte, 32)
	if _, err := io.ReadFull(reader, header); err != nil {
		return nil, err
	}
	if string(header[:4]) != "DKIF" || string(header[8:12]) != "AV01" {
		return nil, fmt.Errorf("not an AV1 IVF file")
	}

	var frames [][]byte
	for reader.Len() > 0 {
		var size uint32
		if err := binary.Read(reader, binary.LittleEndian, &size); err != nil {
			return nil, err
		}
		var timestamp uint64
		if err := binary.Read(reader, binary.LittleEndian, &timestamp); err != nil {
			return nil, err
		}
		frame := make([]byte, size)
		if _, err := io.ReadFull(reader, frame); err != nil {
			return nil, err
		}
		frames = append(frames, frame)
	}
	if len(frames) == 0 {
		return nil, fmt.Errorf("IVF contains no frames")
	}
	return frames, nil
}

func readLEB128(data []byte) (uint32, int, error) {
	var value uint32
	for i := 0; i < 5; i++ {
		if i >= len(data) {
			return 0, 0, io.ErrUnexpectedEOF
		}
		value |= uint32(data[i]&0x7f) << (7 * i)
		if (data[i] & 0x80) == 0 {
			return value, i + 1, nil
		}
	}
	return 0, 0, fmt.Errorf("LEB128 is too long")
}

// extractTemporalUnitOBUs mirrors libdatachannel AV1RtpPacketizer's
// Packetization::TemporalUnit parser used by OBS Studio.
func extractTemporalUnitOBUs(data []byte) ([][]byte, error) {
	index := 0
	if len(data) > 2 && data[0] == 0x12 && data[1] == 0x00 {
		index = 2
	}

	var obus [][]byte
	for index < len(data) {
		start := index
		header := data[index]
		if (header & 0x02) == 0 {
			return nil, fmt.Errorf("OBU at %d has no size field", start)
		}
		headerSize := 1
		if (header & 0x04) != 0 {
			headerSize++
		}
		if start+headerSize > len(data) {
			return nil, io.ErrUnexpectedEOF
		}
		size, lebSize, err := readLEB128(data[start+headerSize:])
		if err != nil {
			return nil, err
		}
		payloadStart := start + headerSize + lebSize
		end := payloadStart + int(size)
		if end > len(data) {
			return nil, io.ErrUnexpectedEOF
		}

		// libdatachannel v0.24.2 (the OBS 32 dependency) forwards the
		// obu_has_size_field bit and its LEB128 field inside the RTP OBU
		// element. This is intentionally different from current master and
		// from Pion's AV1 payloader.
		obu := append([]byte(nil), data[start:end]...)
		obus = append(obus, obu)
		index = end
	}
	return obus, nil
}

type obsAV1Packetizer struct {
	sequenceHeader         []byte
	sequenceNumber         uint16
	timestamp              uint32
	properExtension        bool
	suppressSequenceRepeat bool
	seenSequenceHeader     bool
}

func addBaseLayerExtension(obu []byte) ([]byte, error) {
	if len(obu) == 0 {
		return nil, io.ErrUnexpectedEOF
	}

	headerSize := 1
	if (obu[0] & 0x04) != 0 {
		headerSize++
	}
	if headerSize >= len(obu) {
		return nil, io.ErrUnexpectedEOF
	}

	size, lebSize, err := readLEB128(obu[headerSize:])
	if err != nil {
		return nil, err
	}
	payloadStart := headerSize + lebSize
	if int(size) != len(obu)-payloadStart {
		return nil, fmt.Errorf("OBU size does not match payload")
	}

	ret := make([]byte, 2+int(size))
	ret[0] = (obu[0] &^ 0x06) | 0x04
	ret[1] = 0 // temporal_id=0, spatial_id=0
	copy(ret[2:], obu[payloadStart:])
	return ret, nil
}

// packetize mirrors libdatachannel's AV1RtpPacketizer behavior, including its
// one-byte sequence-header length and W/Z/Y/N aggregation flags.
func (p *obsAV1Packetizer) packetize(temporalUnit []byte) ([]*rtp.Packet, error) {
	obus, err := extractTemporalUnitOBUs(temporalUnit)
	if err != nil {
		return nil, err
	}

	var payloads [][]byte
	for _, obu := range obus {
		if len(obu) == 0 {
			continue
		}
		if p.properExtension {
			obu, err = addBaseLayerExtension(obu)
			if err != nil {
				return nil, err
			}
		}
		obuType := (obu[0] & 0x78) >> 3
		if obuType == 1 {
			if !p.suppressSequenceRepeat || !p.seenSequenceHeader {
				p.sequenceHeader = append(p.sequenceHeader[:0], obu...)
			}
			p.seenSequenceHeader = true
			continue
		}

		index := 0
		var obuPayloads [][]byte
		for index < len(obu) {
			obuCount := 1
			metadataSize := 1
			if len(p.sequenceHeader) != 0 {
				obuCount++
				metadataSize += 1 + len(p.sequenceHeader)
			}

			payloadSize := min(maxFragmentSize, len(obu)-index+metadataSize)
			payload := make([]byte, payloadSize)
			payload[0] = byte(obuCount << 4)
			offset := 1

			if obuCount == 2 {
				payload[0] ^= 0x08
				payload[1] = byte(len(p.sequenceHeader) & 0x7f)
				offset++
				copy(payload[offset:], p.sequenceHeader)
				offset += len(p.sequenceHeader)
				p.sequenceHeader = nil
			}

			copied := copy(payload[offset:], obu[index:])
			index += copied
			if len(obuPayloads) != 0 {
				payload[0] ^= 0x80
			}
			if index < len(obu) {
				payload[0] ^= 0x40
			}
			obuPayloads = append(obuPayloads, payload)
		}
		payloads = append(payloads, obuPayloads...)
	}

	packets := make([]*rtp.Packet, 0, len(payloads))
	for i, payload := range payloads {
		packets = append(packets, &rtp.Packet{
			Header: rtp.Header{
				Version:        2,
				Marker:         i == len(payloads)-1,
				PayloadType:    96,
				SequenceNumber: p.sequenceNumber,
				Timestamp:      p.timestamp,
				SSRC:           videoSSRC,
			},
			Payload: payload,
		})
		p.sequenceNumber++
	}
	p.timestamp += 3000
	return packets, nil
}

func main() {
	if len(os.Args) < 2 || len(os.Args) > 3 {
		panic("usage: r8-obs-aom-whip-publisher <aom-av1.ivf> [proper-extension|no-repeat-sequence]")
	}
	frames, err := readIVF(os.Args[1])
	if err != nil {
		panic(err)
	}
	mode := ""
	if len(os.Args) == 3 {
		mode = os.Args[2]
	}
	properExtension := mode == "proper-extension"
	suppressSequenceRepeat := mode == "no-repeat-sequence"
	if mode != "" && !properExtension && !suppressSequenceRepeat {
		panic("unknown packetization mode")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	videoTrack := &webrtc.OutboundTrack{Caps: pwebrtc.RTPCodecCapability{
		MimeType: pwebrtc.MimeTypeAV1, ClockRate: 90000,
	}}
	audioTrack := &webrtc.OutboundTrack{Caps: pwebrtc.RTPCodecCapability{
		MimeType: pwebrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2,
	}}
	publisher := &whip.Client{
		URL:            mustURL("http://127.0.0.1:18889/live/whip"),
		Publish:        true,
		OutboundTracks: []*webrtc.OutboundTrack{videoTrack, audioTrack},
		HTTPClient:     &http.Client{Timeout: 20 * time.Second},
		BearerToken:    "obs:testpass",
		Log:            quietLogger{},
	}
	if err := publisher.Initialize(ctx); err != nil {
		panic(fmt.Errorf("initialize WHIP publisher: %w", err))
	}
	defer publisher.Close()

	packetizer := &obsAV1Packetizer{
		sequenceNumber:         1000,
		properExtension:        properExtension,
		suppressSequenceRepeat: suppressSequenceRepeat,
	}
	audioSequence := uint16(2000)
	var audioTimestamp uint32
	videoTicker := time.NewTicker(time.Second / 30)
	audioTicker := time.NewTicker(20 * time.Millisecond)
	defer videoTicker.Stop()
	defer audioTicker.Stop()

	fmt.Printf("OBS_AOM_IVF_FRAMES=%d\n", len(frames))
	fmt.Println("OBS_AOM_WHIP_PUBLISHING=READY")
	frameIndex := 0
	for {
		select {
		case <-videoTicker.C:
			packets, err := packetizer.packetize(frames[frameIndex])
			if err != nil {
				panic(err)
			}
			for _, packet := range packets {
				if err := videoTrack.WriteRTP(packet); err != nil {
					panic(err)
				}
			}
			frameIndex = (frameIndex + 1) % len(frames)

		case <-audioTicker.C:
			packet := &rtp.Packet{
				Header: rtp.Header{
					Version:        2,
					Marker:         true,
					PayloadType:    97,
					SequenceNumber: audioSequence,
					Timestamp:      audioTimestamp,
					SSRC:           audioSSRC,
				},
				Payload: []byte{0xf8, 0xff, 0xfe},
			}
			audioSequence++
			audioTimestamp += 960
			if err := audioTrack.WriteRTP(packet); err != nil {
				panic(err)
			}

		case <-ctx.Done():
			return
		}
	}
}
