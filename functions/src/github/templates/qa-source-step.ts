export const QA_SOURCE_SCRIPT = String.raw`"""Trusted preparation, shared with the generated Actions workflow. No repo code runs."""
import io
import json
import os
from pathlib import Path, PurePosixPath
import stat
import sys
import urllib.error
import urllib.request
import zipfile


def call(body):
    request = urllib.request.Request(os.environ['PULSE_QA_SOURCE_URL'],
        data=json.dumps(body).encode(), headers={
            'Authorization': 'Bearer ' + os.environ['PULSE_QA_CREDENTIAL'],
            'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(request, timeout=540) as response:
            return response.read(30 * 1024 * 1024 + 1)
    except urllib.error.HTTPError as error:
        # Only structured infrastructure diagnostics; never echo headers or URLs.
        try:
            diagnostic = json.loads(error.read())
            problems = diagnostic.get('problems') or [{'message': diagnostic.get('message', 'acceso denegado')}]
            raise RuntimeError('; '.join((p.get('repo', '') + ': ' if p.get('repo') and not p['message'].startswith(p['repo']) else '') + p['message'] for p in problems)) from None
        except (ValueError, KeyError):
            raise RuntimeError('QA infrastructure HTTP %d' % error.code) from None


def extract(data, target):
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        total = 0
        entries = []
        roots = set()
        for entry in archive.infolist():
            path = PurePosixPath(entry.filename)
            mode = entry.external_attr >> 16
            if path.is_absolute() or '..' in path.parts or '\\' in entry.filename:
                raise RuntimeError('Snapshot con ruta insegura')
            roots.add(path.parts[0])
            if stat.S_ISLNK(mode) or (stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR)):
                raise RuntimeError('Snapshot con enlace o archivo especial')
            if '.git' in path.parts:
                raise RuntimeError('Snapshot con metadatos Git')
            total += entry.file_size
            if total > 256 * 1024 * 1024:
                raise RuntimeError('Snapshot expandido supera 256 MiB')
            entries.append((entry, path.parts[1:]))
        if len(roots) != 1:
            raise RuntimeError('Snapshot sin raíz única')
        target.mkdir(parents=True)
        for entry, parts in entries:
            if not parts:
                continue
            dest = target.joinpath(*parts)
            if entry.is_dir():
                dest.mkdir(parents=True, exist_ok=True)
            else:
                dest.parent.mkdir(parents=True, exist_ok=True)
                with dest.open('xb') as output:
                    output.write(archive.read(entry))
                dest.chmod(0o444)
        for directory in sorted((p for p in target.rglob('*') if p.is_dir()), reverse=True):
            directory.chmod(0o555)
        target.chmod(0o555)


def main():
    identifier = os.environ['PULSE_QA_IDENTIFIER']
    root = Path(os.environ['PULSE_QA_ROOT'])
    manifest = json.loads(call({'identifier': identifier}))
    expected = json.loads(os.environ.get('PULSE_QA_EXPECTED_REPOS', 'null'))
    if expected is not None and sorted(expected) != sorted(r['repo'] for r in manifest['repositories']):
        raise RuntimeError('El proyecto cambió desde el dispatch; repetí el run')
    primary = os.environ.get('PULSE_QA_PRIMARY_REPO')
    primary_snapshot = next((r for r in manifest['repositories'] if r['repo'] == primary), None)
    if os.environ.get('PULSE_QA_MANIFEST_ONLY') == '1':
        if not primary_snapshot:
            raise RuntimeError('Repositorio anfitrión fuera del proyecto')
        with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
            output.write('head_sha=' + primary_snapshot['sha'] + '\n')
        return
    expected_head = os.environ.get('PULSE_QA_EXPECTED_PRIMARY_SHA')
    if expected_head and (not primary_snapshot or primary_snapshot['sha'] != expected_head):
        raise RuntimeError('El head cambió desde verify; repetí el run')
    for snapshot in manifest['repositories']:
        repo = snapshot['repo']
        parts = repo.split('/')
        if len(parts) != 2 or any(not part or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-' for c in part) for part in parts):
            raise RuntimeError('Repositorio inválido en snapshot')
        archive = call({'identifier': identifier, 'repo': repo, 'sha': snapshot['sha']})
        extract(archive, root / repo.replace('/', '__'))
    root.mkdir(parents=True, exist_ok=True)
    (root / 'qa-sources.json').write_text(json.dumps(manifest))
    print('QA sources ready.')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Infrastructure is reported before claiming/evaluating a review.
        try:
            body = {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call', 'params': {'name': 'pulse_comment_issue', 'arguments': {'identifier': os.environ['PULSE_QA_IDENTIFIER'], 'body': 'QA no arrancó: fallo de infraestructura al preparar repositorios. ' + str(error)}}}
            request = urllib.request.Request(os.environ['PULSE_QA_SOURCE_URL'].replace('/pulseQaSource', '/pulseMcp'), data=json.dumps(body).encode(), headers={'Authorization': 'Bearer ' + os.environ['PULSE_QA_CREDENTIAL'], 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream'})
            with urllib.request.urlopen(request, timeout=30):
                pass
        except Exception:
            pass
        if os.environ.get('PULSE_QA_RUN_ID'):
            try:
                body = {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/call', 'params': {'name': 'pulse_report_run', 'arguments': {'runId': os.environ['PULSE_QA_RUN_ID'], 'outcome': 'failed'}}}
                request = urllib.request.Request(os.environ['PULSE_QA_SOURCE_URL'].replace('/pulseQaSource', '/pulseMcp'), data=json.dumps(body).encode(), headers={'Authorization': 'Bearer ' + os.environ['PULSE_QA_CREDENTIAL'], 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream'})
                with urllib.request.urlopen(request, timeout=30):
                    pass
            except Exception:
                pass
        print('QA infrastructure: ' + str(error), file=sys.stderr)
        sys.exit(1)
`;

export function qaSourceStep(manifestOnly = false): string {
  const code = QA_SOURCE_SCRIPT.split('\n').map((line) => line ? '          ' + line : '').join('\n');
  return `      - name: Preflight y snapshots de todos los repos del proyecto
        id: sources
        env:
          PULSE_QA_SOURCE_URL: https://us-east4-pulse-app-93.cloudfunctions.net/pulseQaSource
          PULSE_QA_CREDENTIAL: \${{ secrets.PULSE_QA_MCP_KEY }}
          PULSE_QA_IDENTIFIER: \${{ github.event.client_payload.issueIdentifier }}
          PULSE_QA_RUN_ID: \${{ github.event.client_payload.runId }}
          PULSE_QA_PRIMARY_REPO: \${{ github.repository }}
          PULSE_QA_MANIFEST_ONLY: '${manifestOnly ? '1' : '0'}'
${manifestOnly ? '' : "          PULSE_QA_EXPECTED_PRIMARY_SHA: ${{ needs.prepare.outputs.head_sha }}\n"}          PULSE_QA_ROOT: \${{ github.workspace }}/qa-sources
        run: |
          python3 - <<'PULSE_QA_SOURCES'
${code}
          PULSE_QA_SOURCES
`;
}
