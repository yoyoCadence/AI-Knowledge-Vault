/**
 * Lightweight, explainable language detection (IMPORT_PIPELINE §7). Prefers the document's own
 * declaration; otherwise uses script ratios. Distinguishes Traditional vs Simplified Chinese using
 * characters that differ between the two scripts. Returns BCP-47-ish tags or "und".
 */
const TRADITIONAL = "們這個為說會來時對開發學國與體經關點長動進現問題從實種業產機資東還應過當樣區數識認計論據結構處統歷層變歲傳導條華準圖書讀寫聽視覺網頁錄類價響轉輸際"; // prettier-ignore
const SIMPLIFIED = "们这个为说会来时对开发学国与体经关点长动进现问题从实种业产机资东还应过当样区数识认计论据结构处统历层变岁传导条华准图书读写听视觉网页录类价响转输际"; // prettier-ignore

const TRADITIONAL_SET = new Set([...TRADITIONAL].filter((char) => !SIMPLIFIED.includes(char)));
const SIMPLIFIED_SET = new Set([...SIMPLIFIED].filter((char) => !TRADITIONAL.includes(char)));

export function normalizeDeclaredLanguage(value: string | null | undefined): string | null {
  if (!value) return null;
  const tag = value.trim().toLowerCase().replace("_", "-");
  if (!/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/.test(tag)) return null;
  if (tag === "zh-tw" || tag === "zh-hk" || tag === "zh-hant" || tag.startsWith("zh-hant-"))
    return "zh-Hant";
  if (tag === "zh-cn" || tag === "zh-sg" || tag === "zh-hans" || tag.startsWith("zh-hans-"))
    return "zh-Hans";
  return tag.split("-")[0] ?? null;
}

export function detectLanguage(text: string, declared?: string | null): string {
  const fromDeclaration = normalizeDeclaredLanguage(declared);
  const sample = text.slice(0, 20_000);
  let han = 0;
  let kana = 0;
  let hangul = 0;
  let latin = 0;
  let traditional = 0;
  let simplified = 0;
  for (const char of sample) {
    if (/\p{Script=Han}/u.test(char)) {
      han += 1;
      if (TRADITIONAL_SET.has(char)) traditional += 1;
      else if (SIMPLIFIED_SET.has(char)) simplified += 1;
    } else if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(char)) kana += 1;
    else if (/\p{Script=Hangul}/u.test(char)) hangul += 1;
    else if (/[A-Za-z]/.test(char)) latin += 1;
  }
  const letters = han + kana + hangul + latin;

  let detected = "und";
  if (letters >= 20) {
    if (kana / letters > 0.1) detected = "ja";
    else if (hangul / letters > 0.3) detected = "ko";
    else if (han / letters >= 0.3) {
      if (traditional > simplified * 1.5 && traditional >= 2) detected = "zh-Hant";
      else if (simplified > traditional * 1.5 && simplified >= 2) detected = "zh-Hans";
      else detected = "zh";
    } else if (latin / letters > 0.6) detected = "en";
  }

  // A declaration is trusted unless the content clearly contradicts its script family.
  if (
    fromDeclaration &&
    (detected === "und" || fromDeclaration.split("-")[0] === detected.split("-")[0])
  ) {
    return fromDeclaration === "zh" && detected.startsWith("zh") ? detected : fromDeclaration;
  }
  return detected;
}
