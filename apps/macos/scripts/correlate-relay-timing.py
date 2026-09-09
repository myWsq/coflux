#!/usr/bin/env python3
"""关联隔离输入观察器与opaque relay帧时序；不能当作无插桩性能基线。"""
import argparse
import json
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--native-log', required=True, type=Path)
parser.add_argument('--relay-log', required=True, type=Path)
parser.add_argument('--output', required=True, type=Path)
args = parser.parse_args()
frames = {}
malformed_lines = []
for line_number, line in enumerate(args.relay_log.read_text().splitlines(), 1):
    if not line.startswith('RELAY_FRAME_TIMING '):
        continue
    try:
        frame = json.loads(line.split(' ', 1)[1])
    except json.JSONDecodeError:
        malformed_lines.append(line_number)
        continue
    frames.setdefault(int(frame['fingerprint']), []).append(frame)
rounds = [json.loads(line.split(' ', 1)[1]) for line in args.native_log.read_text().splitlines()
          if line.startswith('NATIVE_INPUT_TRANSPORT_TRACE ')]
if not rounds:
    raise SystemExit('没有完整原生采样，拒绝生成成功报告')
results, missing = [], []
for run, samples in enumerate(rounds):
    for sample in samples:
        matches = {}
        for name, field in [('input', 'lastInputFingerprint'), ('applied', 'inputAppliedFingerprint'), ('output', 'outputAckFingerprint')]:
            if field not in sample:
                missing.append({'run': run, 'index': sample['index'], 'field': field, 'reason': '客户端未观察到'})
                continue
            candidates = [frame for frame in frames.get(int(sample[field]), [])
                          if sample['startedWallMS'] - 5 <= frame['receivedWallMS'] <= sample['startedWallMS'] + sample['roundtripMS'] + 5]
            if len(candidates) != 1:
                missing.append({'run': run, 'index': sample['index'], 'field': field, 'candidates': len(candidates)})
            else:
                matches[name] = candidates[0]
        if len(matches) != 3:
            continue
        start = sample['startedWallMS']
        entry = {'run': run, 'sample': sample, 'frames': matches,
                 'clientSendToRelayMS': matches['input']['receivedWallMS'] - start - sample['lastSendMS'],
                 'relayInputForwardMS': matches['input']['sentWallMS'] - matches['input']['receivedWallMS'],
                 'daemonAppliedRoundtripMS': matches['applied']['receivedWallMS'] - matches['input']['sentWallMS'],
                 'relayAppliedForwardMS': matches['applied']['sentWallMS'] - matches['applied']['receivedWallMS'],
                 'relayToClientAppliedMS': start + sample['inputAppliedAckMS'] - matches['applied']['sentWallMS'],
                 'relayToClientOutputMS': start + sample['ackReceivedMS'] - matches['output']['sentWallMS']}
        results.append(entry)
report = {'nativeLog': str(args.native_log), 'relayLog': str(args.relay_log), 'roundCount': len(rounds),
          'matched': len(results), 'missing': missing, 'malformedRelayLines': malformed_lines, 'samples': results,
          'scope': '同机wall clock关联；含日志/指纹开销。daemon往返含两侧socket与执行排队，客户端接收含socket读取与应用调度，非内核收包时间。'}
args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'roundCount': len(rounds), 'matched': len(results), 'missing': len(missing), 'malformedRelayLines': len(malformed_lines)}, ensure_ascii=False))
for row in sorted(results, key=lambda r: r['sample']['roundtripMS'], reverse=True)[:5]:
    print(json.dumps({k: round(v, 3) for k, v in row.items() if k.endswith('MS')} | {'roundtripMS': row['sample']['roundtripMS']}, ensure_ascii=False))
if missing:
    raise SystemExit('部分帧未唯一关联；报告保留缺失，不声称完整关联')
