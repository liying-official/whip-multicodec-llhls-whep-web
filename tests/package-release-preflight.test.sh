#!/usr/bin/env bash
# Each case owns a fresh source/output/temp tree. Deadlines detect failure;
# timeout exit codes are never accepted as a successful rejection.
set -Eeuo pipefail
root=${PKG_TEST_SOURCE_ROOT:-$(cd -- "$(dirname -- "$0")/.." && pwd -P)}
exec python3 - "$root" "$@" <<'PY'
import hashlib, json, os, pathlib, re, shutil, signal, stat, subprocess, sys, tarfile, tempfile, time

source = pathlib.Path(sys.argv[1]).resolve()
negative_only = '--negative-only' in sys.argv[2:]
evidence = pathlib.Path(os.environ['PKG_TEST_EVIDENCE_DIR']).resolve() if os.environ.get('PKG_TEST_EVIDENCE_DIR') else None
if evidence: evidence.mkdir(parents=True, exist_ok=True)
required = ['tools/release-basename.txt', 'README.md', 'README.en.md', 'BUILDING.md', 'VERSION.txt', 'certs/README.txt', 'tools/release-managed-files.txt']
types = ['fifo', 'directory', 'link-file', 'link-fifo', 'dangling', 'missing']
failures = 0
count = 0
reference = None
basename = (source/'tools/release-basename.txt').read_text().strip()+'.tar.gz'
epoch = 1788652800

def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def snapshot(root):
    return {str(p.relative_to(root)): (digest(p), stat.S_IMODE(p.stat().st_mode)) for p in root.rglob('*') if p.is_file() and not p.is_symlink()}
def remove(p):
    if p.is_symlink() or p.exists():
        if p.is_dir() and not p.is_symlink(): shutil.rmtree(p)
        else: p.unlink()
def alter_type(src, base, path, kind):
    p = src/path
    remove(p)
    if kind == 'fifo': os.mkfifo(p)
    elif kind == 'directory': p.mkdir()
    elif kind == 'link-file':
        target=base/'outside-file'; target.write_text('fixture'); p.symlink_to(target)
    elif kind == 'link-fifo':
        target=base/'outside-fifo'; os.mkfifo(target); p.symlink_to(target)
    elif kind == 'dangling': p.symlink_to(base/'absent-target')

def validate_archive(archive, src, changed=None):
    root = basename[:-7]
    with tarfile.open(archive, 'r:gz') as tf:
        members = tf.getmembers()
        names = [m.name for m in members]
        assert len(names) == len(set(names))
        for m in members:
            assert m.name == root or m.name.startswith(root+'/')
            assert '..' not in pathlib.PurePosixPath(m.name).parts
            assert m.isfile() or m.isdir()
            assert m.uid == m.gid == 0 and m.mtime == epoch
            assert m.mode in (0o644, 0o755)
        files = {m.name[len(root)+1:]: tf.extractfile(m).read() for m in members if m.isfile()}
        canonical = files['tools/release-managed-files.txt'].decode().splitlines()
        assert canonical == sorted(set(canonical))
        assert set(canonical) == set(files)-{'SHA256SUMS'}
        lines = files['SHA256SUMS'].decode().splitlines()
        assert [line[66:] for line in lines] == canonical
        for line in lines:
            assert line[64:66] == '  ' and hashlib.sha256(files[line[66:]]).hexdigest() == line[:64]
        assert files['config.env'] == b'PUBLIC_DOMAIN=\nPUBLIC_HTTPS_PORT=443\nTLS_CERT=certs/fullchain.pem\nTLS_KEY=certs/privkey.pem\nWHIP_IP=\nINGEST_ALLOW_CIDRS=\nPUBLIC_HOST=\n'
        assert not any(n.startswith(('runtime/', 'logs/')) or n == 'config.local.env' or (n.startswith('certs/') and n != 'certs/README.txt') for n in files)
        if changed: assert files[changed] == (src/changed).read_bytes()
    side = archive.with_name(archive.name+'.sha256').read_text().split()
    assert side == [digest(archive), archive.name]

def run_case(name, mutate=None, positive=False, early_path=None, same=False, changed=None, existing=None):
    global failures, count, reference
    with tempfile.TemporaryDirectory(prefix='obs-package-preflight.') as temp:
        base=pathlib.Path(temp); src=base/'source'; out=base/'out'; tmp=base/'tmp'; shim=base/'shim'
        for p in (src, out, tmp, shim): p.mkdir()
        subprocess.run(['cp', '-a', '--reflink=auto', str(source)+'/.', str(src)], check=True)
        archive=out/(basename if name != 'wrong-basename' else 'wrong.tar.gz')
        sentinel=out/'preexisting-sentinel'; sentinel.write_bytes(b'preserve output'); sentinel.chmod(0o640)
        if existing: (out/(basename+existing)).write_bytes(b'preexisting release output')
        if mutate: mutate(src, base)
        out_before=snapshot(out)
        # Capture source regular bytes without following links/FIFOs. Packaging
        # may normalize its staging copy but must not mutate input deployment.
        src_before=snapshot(src)
        (shim/'mktemp').write_text('#!/bin/sh\nprintf "called\\n" >> "$PKG_MKTEMP_TRACE"\nexec /usr/bin/mktemp "$@"\n')
        (shim/'mktemp').chmod(0o755)
        trace=base/'mktemp.trace'
        env=dict(os.environ, SOURCE_DATE_EPOCH=str(epoch), LC_ALL='C', TMPDIR=str(tmp), PATH=str(shim)+':'+os.environ['PATH'], PKG_MKTEMP_TRACE=str(trace))
        deadline=180 if positive else 5
        command=['timeout','-k','2',str(deadline),'bash',str(src/'tools/package-release.sh'),str(archive)]
        start=time.monotonic()
        p=subprocess.Popen(command,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
        stdout, stderr=p.communicate()
        elapsed=time.monotonic()-start
        residual=False
        try: os.killpg(p.pid,0); residual=True
        except ProcessLookupError: pass
        if residual:
            os.killpg(p.pid,signal.SIGKILL)
        output=stdout.decode(errors='replace'); error=stderr.decode(errors='replace')
        ok=True; detail=''
        try:
            assert not residual, 'residual process group'
            assert p.returncode not in (124,137) and p.returncode >= 0, 'deadline/kill is not product rejection'
            assert not list(tmp.iterdir()), 'temporary staging residue'
            assert src_before == snapshot(src), 'input source mutated'
            for n,v in out_before.items(): assert snapshot(out).get(n)==v, 'preexisting output changed'
            if positive:
                assert p.returncode == 0, error
                validate_archive(archive,src,changed)
                current=digest(archive)
                if reference is None: reference=current
                if same: assert reference==current, 'archive differs from normal reference'
                if changed: assert reference!=current, 'legal source change absent from archive'
                assert set(snapshot(out))==set(out_before)|{basename,basename+'.sha256'}
            else:
                assert p.returncode != 0, 'unexpected packaging success'
                assert snapshot(out)==out_before and set(p.name for p in out.iterdir())==set(out_before), 'new or changed output files'
                if early_path:
                    assert early_path in error, 'error does not locate path'
                    assert not trace.exists(), 'metadata rejected after staging/temp creation'
                    assert elapsed<5, 'rejection too slow'
        except AssertionError as e:
            ok=False; detail=str(e)
        count+=1
        if not ok: failures+=1
        record=dict(TEST_ID='PKG-'+name,TARGET='fresh disposable source copy',EVIDENCE_LEVEL='E3',COMMAND=command,RC=p.returncode,ELAPSED_SECONDS=round(elapsed,3),VERDICT='PASS' if ok else 'FAIL',DETAIL=detail,STDERR=error,RESIDUAL_PROCESS_GROUP=residual)
        print(json.dumps(record),flush=True)
        if evidence:
            with (evidence/'results.jsonl').open('a') as f: f.write(json.dumps(record)+'\n')
            (evidence/(name+'.stdout')).write_text(output)
            (evidence/(name+'.stderr')).write_text(error)

for path in required+['SHA256SUMS','config.env']:
    for kind in types:
        if path in ('SHA256SUMS','config.env') and kind=='missing': continue
        run_case(path.replace('/','_')+'-'+kind,lambda s,b,p=path,k=kind: alter_type(s,b,p,k),early_path=path)
run_case('wrong-basename')
for document in ['README.md','README.en.md','BUILDING.md']:
    def stale(s,b,p=document):
        f=s/p; f.write_text(re.sub(r'weak-network-fix[0-9]+(?:-repaired-v[0-9]+)?','weak-network-fix999',f.read_text()))
    run_case('stale-'+document,stale)
run_case('wrong-version',lambda s,b: (s/'VERSION.txt').write_text('V9.99\n'))
run_case('extra-fifo',lambda s,b: os.mkfifo(s/'extra-fifo'))
run_case('extra-file',lambda s,b: (s/'extra-file').write_text('unmanaged'))
run_case('listed-member-link',lambda s,b: alter_type(s,b,'web/app.js','link-file'))
for fault in ['empty','duplicate','noncanonical','omission','unsorted']:
    def canonical(s,b,fault=fault):
        p=s/'tools/release-managed-files.txt'; lines=p.read_text().splitlines()
        if fault=='empty': lines=[]
        elif fault=='duplicate': lines.append(lines[-1])
        elif fault=='noncanonical': lines[0]='./'+lines[0]
        elif fault=='omission': lines.remove('stop.sh')
        elif fault=='unsorted': lines.reverse()
        p.write_text('\n'.join(lines)+'\n')
    run_case('canonical-'+fault,canonical)
# Empty string is a valid suffix for an existing archive.
run_case('existing-archive',lambda s,b: (b/'out'/basename).write_bytes(b'preexisting release output'))
run_case('existing-sidecar',existing='.sha256')
if not negative_only:
    run_case('normal-A',positive=True)
    run_case('normal-B',positive=True,same=True)
    for kind in ['missing','empty','malformed']:
        def sha_change(s,b,k=kind):
            p=s/'SHA256SUMS'
            if k=='missing': p.unlink()
            else: p.write_text('' if k=='empty' else 'malformed ordinary source manifest\n')
        run_case('input-sha-'+kind,sha_change,positive=True,same=True)
    run_case('config-missing',lambda s,b: (s/'config.env').unlink(),positive=True,same=True)
    def comment(s,b):
        p=s/'web/app.js'; p.write_bytes(p.read_bytes()+b'\n// Disposable package hash regression.\n')
    run_case('legal-source-change',comment,positive=True,changed='web/app.js')
    def exclusions(s,b):
        (s/'config.env').write_text('PUBLIC_DOMAIN=fixture.invalid\nWHIP_IP=192.0.2.10\n')
        for name in ['runtime/publish.credentials','logs/fixture.log','certs/privkey.pem','config.local.env','CHANGELOG.md','CHANGELOG.en.md','local-only/CHANGELOG.full.md','local-only/CHANGELOG.full.en.md','bin/.gitkeep']:
            p=s/name; p.parent.mkdir(exist_ok=True); p.write_text('fixture-only-secret\n')
    run_case('config-and-exclusions',exclusions,positive=True,same=True)
print(f'PACKAGE_RELEASE_PREFLIGHT_CASES={count} FAILURES={failures}',flush=True)
sys.exit(bool(failures))
PY
