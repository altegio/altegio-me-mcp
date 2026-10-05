#!/usr/bin/env python3
"""CI enforces a forward release number, including release-script-only edits."""
import json
import subprocess
import sys

base, head = sys.argv[1:]
changed = subprocess.check_output(['git', 'diff', '--name-only', base, head], text=True).splitlines()
production = [path for path in changed if not (path.startswith(('docs/', '.github/')) or path.endswith('.md'))]
if production:
    def sequence(ref):
        result = subprocess.run(['git', 'show', ref + ':release.json'], capture_output=True, text=True)
        return 0 if result.returncode else json.loads(result.stdout)['sequence']
    if sequence(head) <= sequence(base):
        sys.exit('Increment release.json sequence for every operational/runtime release and rollback')
    print('PASS: forward release sequence')
