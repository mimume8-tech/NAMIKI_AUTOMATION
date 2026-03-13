# check_receipt.py
# usage: python check_receipt.py 国保レセプト.pdf 社保レセプト.pdf

import re
import sys
from collections import defaultdict

# ---- text extraction (prefer PyMuPDF for 2-column stability) ----
def extract_pages_text(pdf_path: str):
    try:
        import fitz  # PyMuPDF
        doc = fitz.open(pdf_path)
        pages = []
        for i in range(doc.page_count):
            page = doc.load_page(i)
            blocks = page.get_text("blocks")  # (x0,y0,x1,y1,text,block_no,block_type)
            blocks = sorted(blocks, key=lambda b: (round(b[1], 1), round(b[0], 1)))
            text = "\n".join(b[4] for b in blocks if b[4] and b[4].strip())
            pages.append(text)
        return pages
    except Exception:
        # fallback: pdfplumber
        import pdfplumber
        pages = []
        with pdfplumber.open(pdf_path) as pdf:
            for p in pdf.pages:
                pages.append(p.extract_text() or "")
        return pages

# ---- helpers ----
RECEPT_NO_PATTERNS = [
    re.compile(r"^\s*(\d+)\s+点検用レセプトです", re.M),
    re.compile(r"○\s*(\d+)", re.M),
]

def get_receipt_no(page_text: str):
    for pat in RECEPT_NO_PATTERNS:
        m = pat.search(page_text)
        if m:
            return m.group(1)
    return None

def has_explain_phrase(text: str):
    return ("投与した抗うつ薬又は抗精神病薬" in text) and ("説明を行った" in text)

# drug patterns (base-name normalization)
AD = {
    "サインバルタ": "duloxetine",
    "デュロキセチン": "duloxetine",
    "リフレックス": "mirtazapine",
    "ミルタザピン": "mirtazapine",
    "レクサプロ": "escitalopram",
    "エスシタロプラム": "escitalopram",
    "パキシル": "paroxetine",
    "パロキセチン": "paroxetine",
    "ジェイゾロフト": "sertraline",
    "セルトラリン": "sertraline",
    "デプロメール": "fluvoxamine",
    "ルボックス": "fluvoxamine",
    "フルボキサミン": "fluvoxamine",
    "イフェクサー": "venlafaxine",
    "ベンラファキシン": "venlafaxine",
    "トリンテリックス": "vortioxetine",
    "ボルチオキセチン": "vortioxetine",
    "レスリン": "trazodone",
    "トラゾドン": "trazodone",
    "トレドミン": "milnacipran",
    "ミルナシプラン": "milnacipran",
}

AP = {
    "エビリファイ": "aripiprazole",
    "アリピプラゾール": "aripiprazole",
    "レキサルティ": "brexpiprazole",
    "ブレクスピプラゾール": "brexpiprazole",
    "ロナセン": "blonanserin",
    "ラツーダ": "lurasidone",
    "インヴェガ": "paliperidone",
    "ジプレキサ": "olanzapine",
    "セロクエル": "quetiapine",
    "リスパダール": "risperidone",
    "ヒルナミン": "chlorpromazine",
    "ドグマチール": "sulpiride",
}

DIVIDER_RE = re.compile(r"―{5,}")  # long dash lines

def blocks(text: str):
    # split into rough "prescription blocks"
    parts = DIVIDER_RE.split(text)
    return [p for p in parts if p.strip()]

def count_drugs_in_block(block_text: str):
    # only consider blocks that look like medication lists
    if not any(k in block_text for k in ["錠", "カプセル", "内用液", "ｇ", "ｍｇ"]):
        return set(), set()
    ads = set()
    aps = set()
    for k, v in AD.items():
        if k in block_text:
            ads.add(v)
    for k, v in AP.items():
        if k in block_text:
            aps.add(v)
    return ads, aps

def needs_explain(text: str):
    # if ANY block contains >=2 unique antidepressants OR >=2 unique antipsychotics
    for b in blocks(text):
        ads, aps = count_drugs_in_block(b)
        if len(ads) >= 2 or len(aps) >= 2:
            return True
    return False

def has_blood_test(text: str):
    # conservative trigger
    return any(k in text for k in ["血液学的検査", "生化学検査", "血算", "採血", "血液検査"])

def has_blood_reason(text: str):
    return "血液学的検査および生化学検査を行った理由について" in text

# ---- main check ----
def check_pdf(pdf_path: str):
    pages = extract_pages_text(pdf_path)
    by_no = defaultdict(list)
    for t in pages:
        no = get_receipt_no(t)
        if no:
            by_no[no].append(t)

    fail = {1: [], 2: [], 3: [], 4: []}

    for no, texts in by_no.items():
        full = "\n".join(texts)

        # ① mucosta/ rebamipide => chronic gastritis
        if ("ムコスタ" in full) or ("レバミピド" in full) or ("レバミピド" in full):
            if "慢性胃炎" not in full:
                fail[1].append(no)

        # ② (ONLY if truly multi-AD or multi-AP in same prescription)
        if needs_explain(full) and (not has_explain_phrase(full)):
            fail[2].append(no)

        # ③ blood test => reason paragraph
        if has_blood_test(full) and (not has_blood_reason(full)):
            fail[3].append(no)

        # ④ aripiprazole => schizophrenia
        if ("エビリファイ" in full) or ("アリピプラゾール" in full):
            if "統合失調症" not in full:
                fail[4].append(no)

    for k in fail:
        fail[k] = sorted(set(fail[k]), key=lambda x: int(x))
    return fail

def print_report(title, fail):
    def fmt(nums): return "なし" if not nums else ", ".join(nums)
    print(f"\n=== {title} ===")
    print(f"①（ムコスタ/レバミピド→慢性胃炎）: {fmt(fail[1])}")
    print(f"②（同一処方で2剤→説明文言）: {fmt(fail[2])}")
    print(f"③（採血→理由文言）: {fmt(fail[3])}")
    print(f"④（エビリファイ/アリピプラゾール→統合失調症）: {fmt(fail[4])}")

if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("usage: python check_receipt.py 国保レセプト.pdf 社保レセプト.pdf")
        sys.exit(1)

    kokuho, shaho = sys.argv[1], sys.argv[2]
    print_report("国保", check_pdf(kokuho))
    print_report("社保", check_pdf(shaho))
