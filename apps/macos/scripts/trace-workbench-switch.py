"""附加到显式准备中的隔离工作台基准；轨迹不能充当无干扰耗时基线。"""
import argparse,json,time,subprocess
from pathlib import Path
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--phase-file',type=Path,required=True)
parser.add_argument('--app-executable',type=Path,required=True)
parser.add_argument('--output-dir',type=Path,required=True)
args=parser.parse_args()
args.output_dir.mkdir(parents=True,exist_ok=True)
phase=args.phase_file
expected=args.app_executable.resolve()
start=time.time();deadline=time.monotonic()+180
while time.monotonic()<deadline:
 try:
  state=json.loads(phase.read_text())
  if phase.stat().st_mtime>=start and state['state']=='preparing':break
 except FileNotFoundError:pass
 time.sleep(.05)
else:raise RuntimeError('未观察到新的Instruments准备阶段')
pid=str(state['pid'])
actual=Path(subprocess.check_output(['ps','-p',pid,'-o','comm='],text=True).strip()).resolve()
assert actual==expected,(actual,expected)
trace=args.output_dir / ('workbench-metal-'+str(time.time_ns())+'.trace')
metadata={'pid':int(pid),'runID':state['runID'],'trace':str(trace),'observations':[],'scope':'受Instruments干扰的隔离采样，不纳入基准'}
with open(args.output_dir / 'record.log','w') as log:
 process=subprocess.Popen(['xcrun','xctrace','record','--template','Metal System Trace','--attach',pid,'--time-limit','25s','--output',str(trace)],stdout=log,stderr=subprocess.STDOUT)
 previous=None
 while process.poll() is None:
  try:
   current=json.loads(phase.read_text())
   if current!=previous:
    metadata['observations'].append({'observedAt':time.time(),**current});previous=current
  except FileNotFoundError:pass
  time.sleep(.05)
metadata['returnCode']=process.returncode
(args.output_dir / 'record.json').write_text(json.dumps(metadata,ensure_ascii=False,indent=2))
print(json.dumps(metadata,ensure_ascii=False),flush=True)
raise SystemExit(process.returncode)
