#!/usr/bin/env python3
"""Build/push on one Docker context and pull by digest on an independent node with an empty image cache.
Uses the operator's existing Docker login/TLS configuration; changes none of it.
"""
import argparse
import json
import ipaddress
from pathlib import Path
import re
import subprocess
import time
import uuid


class DockerError(RuntimeError):
    def __init__(self, context, args, stderr):
        self.stderr = stderr
        super().__init__(f'Docker {args[0]} failed on {context}: {stderr[-2500:]}')


def docker(context, args, *, timeout=1800):
    result = subprocess.run(['docker', '--context', context, *args], text=True, capture_output=True, timeout=timeout)
    if result.returncode:
        raise DockerError(context, args, result.stderr)
    return result.stdout


def validate_repository(repository):
    if not re.fullmatch(r'[a-z0-9.-]+(?::[0-9]{1,5})?/(?:[a-z0-9._-]+/)*rdf-emulator', repository):
        raise ValueError('Expected host[:port]/[path/]rdf-emulator')
    authority = repository.split('/', 1)[0]
    host, separator, port = authority.partition(':')
    if separator and not 1 <= int(port) <= 65535:
        raise ValueError('Registry port must be 1-65535')
    host = host.rstrip('.')
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        address = None
    if host == 'localhost' or host.endswith('.localhost') or address and (address.is_loopback or address.is_unspecified):
        raise ValueError('Two nodes need the same reachable registry address, not localhost or an unspecified address')


def require_uncached_consumer(context, image_id):
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', image_id):
        raise RuntimeError('Built image has no valid config ID')
    try:
        docker(context, ['image', 'inspect', image_id])
    except DockerError as error:
        expected = r'(?:Error response from daemon: |Error: )No such image: ' + re.escape(image_id)
        if re.fullmatch(expected, error.stderr.strip()):
            return
        raise
    raise RuntimeError('Pull node already has the built image; use an independent node with an empty cache')


def verify_pulled_image(source, pulled, repository, digest, package):
    image_id = source.get('Id', '')
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', image_id) or image_id != pulled.get('Id'):
        raise RuntimeError('Pulled image config differs from the built image')
    labels = source.get('Config', {}).get('Labels') or {}
    if labels.get('remote-device-farm.contract') != 'emulator-v1' or labels.get('remote-device-farm.system-image') != package:
        raise RuntimeError('Built image does not identify the requested farm emulator contract and SDK package')
    if repository + '@' + digest not in pulled.get('RepoDigests', []):
        raise RuntimeError('Pull node did not retain the requested repository digest')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--builder-context', required=True)
    parser.add_argument('--pull-context', required=True)
    parser.add_argument('--package', required=True)
    parser.add_argument('--repository', required=True, help='reachable farm registry host[:port]/rdf-emulator')
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    if not re.fullmatch(r'system-images;android-[A-Za-z0-9._-]+;[A-Za-z0-9._-]+;(x86_64|arm64-v8a|x86)', args.package):
        parser.error('Expected one SDK system image package')
    try:
        validate_repository(args.repository)
    except ValueError as error:
        parser.error(str(error))
    report = {'passed': False, 'package': args.package, 'repository': args.repository}
    context = Path(__file__).resolve().parents[2] / 'agent' / 'emulator-image'
    started = time.monotonic()
    try:
        builder = json.loads(docker(args.builder_context, ['info', '--format', '{{json .}}']))
        target = json.loads(docker(args.pull_context, ['info', '--format', '{{json .}}']))
        if not builder.get('ID') or builder['ID'] == target.get('ID'):
            raise RuntimeError('Two distinct Docker daemons are required; aliases for the same daemon do not count')
        if builder.get('Architecture') != target.get('Architecture'):
            raise RuntimeError('Builder and pull node must have compatible architectures for this test')
        report.update(builderId=builder['ID'], pullNodeId=target['ID'])
        image = args.repository + ':verify-' + uuid.uuid4().hex
        report['tag'] = image
        docker(args.builder_context, ['build', '--build-arg', 'SYSTEM_IMAGE=' + args.package, '-t', image, str(context)], timeout=7200)
        source = json.loads(docker(args.builder_context, ['image', 'inspect', image]))[0]
        require_uncached_consumer(args.pull_context, source.get('Id', ''))
        report['consumerImageAbsentBeforePull'] = True
        pushed = docker(args.builder_context, ['push', image], timeout=1800)
        digest = re.search(r'digest: (sha256:[0-9a-f]{64})', pushed)
        if not digest:
            raise RuntimeError('Registry did not return a pushed manifest digest')
        pinned = image + '@' + digest.group(1)
        report['image'] = pinned
        docker(args.pull_context, ['pull', pinned], timeout=1800)
        pulled = json.loads(docker(args.pull_context, ['image', 'inspect', pinned]))[0]
        verify_pulled_image(source, pulled, args.repository, digest.group(1), args.package)
        report.update(passed=True, imageId=pulled['Id'], elapsedSeconds=round(time.monotonic()-started,2))
    except Exception as error:
        report['error'] = str(error)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report, indent=2))
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
