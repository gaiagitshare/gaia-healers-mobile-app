"""18 Nov 2026 contact audit regressions (no network, nothing written).
  * a stored phone that is a sheet formula ("=9498702692") is NOT the same as the
    sheet's number, so the daily sync rewrites it; real formatting differences
    ("(949) 870-2692" vs "9498702692") still count as the same number;
  * a phone cell exported as a formula comes through without the "=".
Run: python3 test_contact_audit_20261118.py"""
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "tools"))
import vendor_sync as S, vendor_sheet as V
fails = []
def check(ok, label):
    print(("  PASS  " if ok else "  FAIL  ") + label); ok or fails.append(label)
check(not S.same("contact_phone", "=9498702692", "9498702692"), "a '=' phone is rewritten")
check(S.same("contact_phone", "(949) 870-2692", "9498702692"), "formatting alone is the same number")
check(S.same("contact_phone", "+1 949.870.2692", "+19498702692"), "dots and a country code are the same number")
check(V._num("=9498702692") == "9498702692", "a formula cell is read without the '='")
check(V._num("9545511920.0") == "9545511920", "a numeric cell still reads as a whole number")
got = [(x["name"], x["email"]) for x in V.parse_staff("Badge 1: Matt Ma\nemail: mediairpurifier@gmail.com\nBadge 2: Karen Goss\nemail: matt171717@gmail.com")]
check(got == [("Matt Ma", "mediairpurifier@gmail.com"), ("Karen Goss", "matt171717@gmail.com")], "labelled staff lines give the real names and their own addresses: %r" % (got,))
got = [(x["name"], x["email"]) for x in V.parse_staff("Michael Porter - mporter@braintap.com | Shawn Bean - sbean@braintap.com")]
check(got == [("Michael Porter", "mporter@braintap.com"), ("Shawn Bean", "sbean@braintap.com")], "unlabelled lines unchanged")
print("\n%d failed" % len(fails) if fails else "\nALL PASS"); sys.exit(1 if fails else 0)
