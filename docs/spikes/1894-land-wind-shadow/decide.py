"""#1894 §6.3: combine the genoa-table and fock-table runs into the rerun's verdict.
Usage: python3 -I decide.py <results6_genoa.json> <results6_fock.json> <out.json>"""
import json
import sys

g, f = (json.load(open(p)) for p in sys.argv[1:3])
out = dict(
    resolvable=bool(g["resolvable"] and f["resolvable"]),
    option2=bool(g["option2_this_run"] and f["option2_this_run"]),
    rules={k: {"genoa": g["option2_rules"][k], "fock": f["option2_rules"][k]} for k in g["option2_rules"]},
    option1="not decided by this rerun (§6.3)",
)
json.dump(out, open(sys.argv[3], "w"), indent=1)
print(json.dumps(out, indent=1))
