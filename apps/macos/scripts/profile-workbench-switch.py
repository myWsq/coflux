#!/usr/bin/env python3
"""只读采样一个新启动的工作台基准；采样轮不能用于报告性能基线。"""
import argparse
import json
from pathlib import Path
import subprocess
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--phase-file', type=Path, required=True)
    parser.add_argument('--app-executable', type=Path, required=True)
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--timeout', type=float, default=210)
    args = parser.parse_args()
    if args.timeout <= 0:
        parser.error('--timeout 必须大于零')
    started = time.time()
    deadline = time.monotonic() + args.timeout
    captured = set()
    run_id = None
    args.output_dir.mkdir(parents=True, exist_ok=True)
    while time.monotonic() < deadline:
        try:
            if args.phase_file.stat().st_mtime < started:
                time.sleep(.05)
                continue
            state = json.loads(args.phase_file.read_text())
        except FileNotFoundError:
            time.sleep(.05)
            continue
        phase = 'loaded' if state['loaded'] else 'idle'
        if state['state'] != 'sampling' or phase in captured:
            time.sleep(.05)
            continue
        if run_id is not None and state['runID'] != run_id:
            raise RuntimeError('阶段来自不同测试轮次，拒绝合并')
        pid = str(int(state['pid']))
        actual = subprocess.check_output(['ps', '-p', pid, '-o', 'comm='], text=True).strip()
        if Path(actual).resolve() != args.app_executable.resolve():
            raise RuntimeError('目标进程路径不匹配：' + actual)
        run_id = state['runID']
        output = args.output_dir / (phase + '.txt')
        subprocess.run(['sample', pid, '1', '1', '-file', str(output)], check=True)
        record = {'phase': phase, 'pid': int(pid), 'runID': run_id, 'report': str(output),
                  'scope': '1秒调用栈采样；会扰动测试进程，不作为耗时基线'}
        (args.output_dir / (phase + '.json')).write_text(json.dumps(record, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps(record, ensure_ascii=False), flush=True)
        captured.add(phase)
        if len(captured) == 2:
            return
    raise TimeoutError('未等到新测试的两个采样阶段：' + repr(captured))


if __name__ == '__main__':
    main()
