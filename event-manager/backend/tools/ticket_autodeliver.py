# -*- coding: utf-8 -*-
"""Automatic official-ticket email -- the job and its operator commands.

  python3 tools/ticket_autodeliver.py run                 one cycle (the 2-minute timer)
  python3 tools/ticket_autodeliver.py status              mode, last run, counts
  python3 tools/ticket_autodeliver.py pause  --reason ..  stop all sending now
  python3 tools/ticket_autodeliver.py shadow --reason ..  classify only, send nothing
  python3 tools/ticket_autodeliver.py approve-live --template-sha SHA --reason ..
                                                          send GREEN orders automatically
  python3 tools/ticket_autodeliver.py set-cutoff ISO      orders first seen before this
                                                          belong to the bulk send

Live sending is only switched on here, on the server, with the exact template
fingerprint -- never from the dashboard. Every command is written to the audit.
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)
from ticket_delivery import engine, state as st  # noqa: E402


def arg(name):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else None


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'status'
    s = st.DeliveryState()
    who = 'server:' + (os.environ.get('SUDO_USER') or os.environ.get('USER') or 'root')
    try:
        if cmd == 'run':
            # One cycle at a time even if a run overruns the timer.
            import fcntl
            lock = open(os.path.join(os.path.dirname(st.db_path()), '.autodeliver.lock'), 'w')
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                print('another run is in progress')
                return
            engine.run_cycle(engine.Live(), s, engine.em_connect())
        elif cmd == 'status':
            print(json.dumps({'mode': s.mode(), 'template_sha': engine.template_sha(), 'approved_template_sha': s.get('approved_template_sha'),
                              'auto_cutoff': s.get('auto_cutoff'), 'last_run': json.loads(s.get('last_run') or 'null'),
                              'candidates': dict(s.db.execute('select classification,count(*) from delivery_candidates group by 1').fetchall()),
                              'delivered_orders': s.db.execute('select count(*) from order_ticket_delivery').fetchone()[0]}, indent=1))
        elif cmd in ('pause', 'shadow'):
            reason = arg('--reason')
            if not reason:
                raise SystemExit('--reason is required')
            before = s.mode()
            if before != 'paused':
                s.put('mode_before_pause', before, who)
            s.put('mode', 'paused' if cmd == 'pause' else 'shadow', who)
            s.audit(who, 'set_mode', engine.EVENT_ID, None, reason, {'from': before, 'to': s.mode()})
            print('mode:', s.mode())
        elif cmd == 'approve-live':
            sha, reason = arg('--template-sha'), arg('--reason')
            if not reason or sha != engine.template_sha():
                raise SystemExit('Refused: --reason and the exact current --template-sha (%s) are required' % engine.template_sha())
            if not s.get('auto_cutoff'):
                raise SystemExit('Refused: set the cutoff first')
            before = s.mode()
            s.put('approved_template_sha', sha, who)
            s.put('mode', 'live', who)
            s.audit(who, 'approve_live', engine.EVENT_ID, None, reason, {'from': before, 'template_sha': sha})
            print('mode: live')
        elif cmd == 'set-cutoff':
            value = sys.argv[2]
            before = s.get('auto_cutoff')
            s.put('auto_cutoff', value, who)
            s.audit(who, 'set_cutoff', engine.EVENT_ID, None, arg('--reason') or '', {'from': before, 'to': value})
            print('cutoff:', value)
        else:
            raise SystemExit(__doc__)
    finally:
        s.close()


if __name__ == '__main__':
    main()
