"""Read-only audit of canonical same-repository GitHub issue manifests."""
import argparse
import json
import re
import subprocess
import sys
from pathlib import Path


class ReadError(Exception):
    pass


def request(endpoint, paginate=False, absent_ok=False):
    args = ['gh', 'api', endpoint, '-H', 'Accept: application/vnd.github+json']
    if paginate:
        args += ['--paginate', '--slurp']
    try:
        result = subprocess.run(args, capture_output=True, text=True, encoding='utf-8', timeout=60)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ReadError(f'Cannot read {endpoint}: {type(exc).__name__}') from exc
    if result.returncode:
        if absent_ok and re.search(r'HTTP 404\b', result.stderr):
            return None
        raise ReadError(f'Cannot verify {endpoint} (gh exit {result.returncode})')
    try:
        value = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise ReadError(f'Invalid JSON from {endpoint}') from exc
    if paginate:
        if not isinstance(value, list) or any(not isinstance(page, list) for page in value):
            raise ReadError(f'Unexpected paginated response from {endpoint}')
        return [item for page in value for item in page]
    return value


def cyclic(graph):
    active, finished = set(), set()

    def visit(node):
        if node in active:
            return True
        if node in finished:
            return False
        active.add(node)
        if any(visit(child) for child in graph.get(node, [])):
            return True
        active.remove(node)
        finished.add(node)
        return False

    return any(visit(node) for node in graph)


def audit(repo, items, api=request):
    errors, records, parents, dependencies, children = [], {}, {}, {}, {}
    numbers = [item['number'] for item in items]
    if len(set(numbers)) != len(numbers):
        raise ValueError('Duplicate issue numbers in manifest')
    for item in items:
        if type(item['number']) is not int or item['number'] <= 0:
            raise ValueError('Issue numbers must be positive integers')
        if item['kind'] not in {'epic', 'story', 'task', 'bug', 'risk', 'blocker'}:
            raise ValueError('Unknown primary type')
        if item['priority'] not in {'P0', 'P1', 'P2', None}:
            raise ValueError('Invalid priority')
        if item['parent'] is not None and (type(item['parent']) is not int or item['parent'] <= 0):
            raise ValueError('Invalid parent number')
        if not isinstance(item['blocked_by'], list) or any(type(n) is not int or n <= 0 for n in item['blocked_by']):
            raise ValueError('Invalid blocked_by numbers')
        if len(set(item['blocked_by'])) != len(item['blocked_by']):
            raise ValueError('Duplicate dependency in manifest')
    if cyclic({i['number']: [i['parent']] if i['parent'] is not None else [] for i in items}):
        errors.append('Intended hierarchy contains a cycle')
    if cyclic({i['number']: i['blocked_by'] for i in items}):
        errors.append('Intended dependencies contain a cycle')

    def load(number):
        if number in records:
            return
        if len(records) >= 500:
            raise ReadError('Connected graph exceeds 500 issues; review in an explicitly scoped audit')
        base = f'repos/{repo}/issues/{number}'
        record = api(base)
        if 'pull_request' in record:
            raise ReadError(f'#{number} is a pull request rather than an issue')
        records[number] = record
        # A successful list establishes hierarchy API access before treating parent 404 as absence.
        children[number] = api(base + '/sub_issues?per_page=100', paginate=True)
        parent = api(base + '/parent', absent_ok=True)
        parents[number] = None if parent is None else parent['number']
        for relation in ([parent] if parent else []) + children[number]:
            if relation.get('repository_url') != f'https://api.github.com/repos/{repo}':
                raise ReadError('Cross-repository hierarchy requires manual audit')
        blockers = api(base + '/dependencies/blocked_by?per_page=100', paginate=True)
        for relation in blockers:
            if relation.get('repository_url') != f'https://api.github.com/repos/{repo}':
                raise ReadError('Cross-repository dependencies require manual audit')
        dependencies[number] = [b['number'] for b in blockers]
        for linked in ([parents[number]] if parents[number] is not None else []) + dependencies[number]:
            load(linked)

    for number in numbers:
        load(number)
    for item in items:
        number = item['number']
        record = records[number]
        labels = {label['name'] for label in record['labels']}

        def compare(prefix, expected):
            actual = {label for label in labels if label.startswith(prefix)}
            wanted = {prefix + value for value in expected}
            if actual != wanted:
                errors.append(f'#{number}: {prefix} labels {sorted(actual)} differ from {sorted(wanted)}')

        compare('type:', [item['kind']])
        compare('priority:', [] if item['priority'] is None else [item['priority']])
        if item['kind'] == 'risk':
            status = item['risk_status']
            if status not in {'open', 'mitigating', 'accepted', 'resolved', 'retired'}:
                raise ValueError('Invalid risk_status')
            compare('risk:', [status])
            compare('status:', [])
            completed, cancelled = status == 'resolved', status == 'retired'
        else:
            status = item['status']
            if status not in {'backlog', 'ready', 'in-progress', 'in-review', 'done', 'cancelled'}:
                raise ValueError('Invalid status')
            compare('status:', [status] + (['blocked'] if item.get('blocked') else []))
            completed, cancelled = status == 'done', status == 'cancelled'
        expected_state = 'closed' if completed or cancelled else 'open'
        if record['state'] != expected_state:
            errors.append(f'#{number}: issue state differs from {expected_state}')
        if completed or cancelled:
            reason = 'completed' if completed else 'not_planned'
            if record.get('state_reason') != reason:
                errors.append(f'#{number}: closure reason differs from {reason}')
        if 'severity' in item:
            if item['kind'] != 'bug' or item['severity'] not in {None, 'critical', 'high', 'medium', 'low'}:
                raise ValueError('Invalid severity assessment')
            compare('severity:', [] if item['severity'] is None else [item['severity']])
        if parents[number] != item['parent']:
            errors.append(f'#{number}: native parent differs from manifest')
        if set(dependencies[number]) != set(item['blocked_by']):
            errors.append(f'#{number}: native blocked_by differs from manifest')
        for blocker in dependencies[number]:
            reverse = api(f'repos/{repo}/issues/{blocker}/dependencies/blocking?per_page=100', paginate=True)
            if records[number]['id'] not in {entry['id'] for entry in reverse}:
                errors.append(f'#{number}: reverse blocking-list does not confirm dependency')
        if item['parent'] is not None:
            load(item['parent'])
            parent_kind = {l['name'] for l in records[item['parent']]['labels'] if l['name'].startswith('type:')}
            expected_kind = {'story': 'epic', 'task': 'story', 'bug': 'story'}.get(item['kind'])
            valid = expected_kind is not None and parent_kind == {'type:' + expected_kind}
            valid |= item['kind'] == 'task' and parent_kind == {'type:epic'} and bool(item.get('parent_exception'))
            if not valid:
                errors.append(f'#{number}: invalid parent type or missing engineering exception')
            if records[number]['id'] not in {c['id'] for c in children[item['parent']]}:
                errors.append(f'#{number}: reverse parent child-list does not confirm relationship')
        elif item['kind'] in {'story', 'task'} and not item.get('parent_exception'):
            errors.append(f'#{number}: missing parent/refinement exception')
    if cyclic({n: [p] if p is not None else [] for n, p in parents.items()}):
        errors.append('Actual hierarchy contains a cycle')
    if cyclic(dependencies):
        errors.append('Actual dependency graph contains a cycle')
    return errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('repo', help='OWNER/REPO on github.com')
    parser.add_argument('manifest', type=Path)
    args = parser.parse_args()
    try:
        if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', args.repo):
            raise ValueError('Expected OWNER/REPO')
        items = json.loads(args.manifest.read_text(encoding='utf-8'))['items']
        if not isinstance(items, list) or not items:
            raise ValueError('Manifest must contain a nonempty items list')
        errors = audit(args.repo, items)
    except (ReadError, ValueError, KeyError, TypeError, OSError) as exc:
        print(json.dumps({'verified': False, 'error': str(exc)}))
        return 2
    print(json.dumps({'verified': not errors, 'issues_checked': len(items), 'mismatches': errors}))
    return 1 if errors else 0


if __name__ == '__main__':
    sys.exit(main())

