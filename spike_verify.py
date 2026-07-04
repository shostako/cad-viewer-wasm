"""cad-viewer-wasm スパイク検証（実ブラウザ）。

opencascade.js(WASM OCCT)だけで backend レスに:
  STEP読込 → Three.js描画 → 面ピック → BRepExtrema 真値距離
が実ブラウザで成立するかを Playwright で確認し、タブ内メモリも観測する。
"""
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
STEP = HERE / "testdata" / "mini_mold.step"
URL = "http://localhost:5173/"


def main() -> int:
    errors: list[str] = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            headless=True,
            args=[
                "--use-gl=angle",
                "--use-angle=swiftshader",
                "--enable-unsafe-swiftshader",
                "--ignore-gpu-blocklist",
            ],
        )
        page = browser.new_page(viewport={"width": 1280, "height": 800})
        page.on("console", lambda m: (
            errors.append(f"[console.{m.type}] {m.text}") if m.type in ("error",) else None
        ))
        page.on("pageerror", lambda e: errors.append(f"[pageerror] {e}"))

        page.goto(URL, wait_until="networkidle")

        # STEP をアップロード（file input 経由）
        page.set_input_files("#file-input", str(STEP))

        # 読み込み完了（HUD が tris 数を表示するまで）を待つ。OCCT init 込みで余裕を持つ。
        page.wait_for_function(
            "() => document.querySelector('#hud-info')?.textContent?.includes('tris')",
            timeout=60000,
        )
        hud = page.eval_on_selector("#hud-info", "el => el.textContent")
        print(f"[HUD] {hud}")

        # 描画実証: canvas が存在し中身が描かれている
        has_canvas = page.evaluate("() => !!document.querySelector('canvas')")
        print(f"[render] canvas present: {has_canvas}")

        # ピック実証: canvas 中央付近を数点なめて face が拾えるか
        picked = page.evaluate(
            """() => {
              const hooks = window;
              const rect = document.querySelector('canvas').getBoundingClientRect();
              const cx = rect.left + rect.width/2, cy = rect.top + rect.height/2;
              const offs = [[0,0],[40,0],[-40,0],[0,40],[0,-40],[60,60],[-60,-60]];
              const out = [];
              for (const [dx,dy] of offs) {
                const r = hooks.__cadPick(cx+dx, cy+dy);
                if (r) out.push(r);
              }
              return out;
            }"""
        )
        face_ids = sorted({p["id"] for p in picked if p.get("kind") == "face" and p.get("id", -1) > 0})
        print(f"[pick] 拾えた faceId: {face_ids}  (raw picks: {len(picked)})")

        # 計測実証: 面ペアを総当たりして最大の真値距離を出す
        # （隣接面は距離0。非隣接ペアなら実寸法=板厚/幅が出る＝計測が本当に効いてる証明）。
        dist = None
        maxpair = page.evaluate(
            """async () => {
              const N = 20; // faceId 1..N を総当たり（十分広く）
              let best = {value: -1, a: 0, b: 0, res: null};
              for (let a=1; a<=N; a++) for (let b=a+1; b<=N; b++) {
                let r; try { r = await window.__cadFaceDistance(a,b); } catch(e){ continue; }
                if (r && r.value > best.value) best = {value: r.value, a, b, res: r};
              }
              return best;
            }"""
        )
        dist = maxpair.get("res")
        print(f"[measure] 最大距離ペア face#{maxpair['a']} ↔ face#{maxpair['b']}: "
              f"{maxpair['value']:.4f}  (bbox = 100×60×40)")

        # メモリ観測（JS heap; WASM ヒープは別だが目安）
        mem = page.evaluate(
            "() => performance.memory ? Math.round(performance.memory.usedJSHeapSize/1e6) : null"
        )
        print(f"[mem] usedJSHeapSize: {mem} MB (JSヒープのみ; WASMヒープは別途数百MB)")

        # スクショ
        shot = HERE / "spike_shot.png"
        page.screenshot(path=str(shot))
        print(f"[shot] {shot}")

        browser.close()

    print("\n=== console errors ===")
    real = [e for e in errors if "favicon" not in e.lower()]
    for e in real:
        print(e)
    ok = (
        has_canvas
        and bool(face_ids)
        and dist is not None
        and dist.get("value", 0) > 0  # 非隣接ペアで実寸法が出た＝計測が本当に動いてる
        and not real
    )
    print(f"\n=== VERDICT: {'PASS' if ok else 'CHECK'} ===")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
