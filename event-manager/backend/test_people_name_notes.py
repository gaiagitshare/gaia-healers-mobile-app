# -*- coding: utf-8 -*-
"""A note the team writes next to a volunteer's name is not part of the name
(17 Nov 2026: "Raymond Herrmann (Pat's Husband)" printed as the surname).
Run:  python3 /root/event/backend/test_people_name_notes.py
"""
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "tools"))
import people_sheet as ps
fails = 0
def check(cond, label, got=None):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + label + ("" if cond else "   %r" % (got,)))
    fails += 0 if cond else 1
for raw, name, note, first, last in (
        ("Raymond Herrmann (Pat's Husband)", "Raymond Herrmann", "Pat's Husband", "Raymond", "Herrmann"),
        ("Kay Raymond (Ambers Friend)", "Kay Raymond", "Ambers Friend", "Kay", "Raymond"),
        ("Nancy Ventura 11", "Nancy Ventura", "11", "Nancy", "Ventura"),
        ("Angie (Bio-Well Scan)", "Angie", "Bio-Well Scan", "Angie", ""),
        ("Elnaz", "Elnaz", "", "Elnaz", ""),
        ("Mary Ann  Smith", "Mary Ann Smith", "", "Mary", "Ann Smith")):
    got = ps.name_and_note(raw) + ps._split_name(raw)
    check(got == (name, note, first, last), "%r -> name %r, note %r" % (raw, name, note), got)
csv_text = "NAME,E-MAIL,PHONE,Area of expertise\nRaymond Herrmann (Pat's Husband),rayh@example.invalid,,\n"
r = ps.parse_volunteers(csv_text)[0]
check((r["name"], r["first_name"], r["last_name"], r["name_note"]) == ("Raymond Herrmann", "Raymond", "Herrmann", "Pat's Husband"),
      "a parsed volunteer row carries the clean name and keeps the note apart", r)
print("\n%s" % ("ALL PASS" if not fails else "FAILED: %d" % fails))
sys.exit(1 if fails else 0)
