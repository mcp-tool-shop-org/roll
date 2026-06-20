<p align="center">
  <a href="README.ja.md">日本語</a> | <a href="README.zh.md">中文</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.md">English</a> | <a href="README.it.md">Italiano</a> | <a href="README.pt-BR.md">Português (BR)</a>
</p>

<p align="center"><img src="https://raw.githubusercontent.com/mcp-tool-shop-org/brand/main/logos/roll/readme.png" width="400" alt="Roll"></p>

<p align="center">
  <a href="https://github.com/mcp-tool-shop-org/roll/actions"><img src="https://github.com/mcp-tool-shop-org/roll/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
  <a href="https://mcp-tool-shop-org.github.io/roll/"><img src="https://img.shields.io/badge/Landing_Page-online-brightgreen" alt="Landing Page"></a>
  <a href="https://www.npmjs.com/package/@mcptoolshop/roll"><img src="https://img.shields.io/npm/v/@mcptoolshop/roll" alt="npm version"></a>
</p>

<p align="center">Universal RPG dice engine — full notation, probability analysis, game tables, and engine integration.</p>

```
npx @mcptoolshop/roll 8d6cs>=5 --analyze
```

## स्थापित करें

```bash
npm install @mcptoolshop/roll
```

इसके लिए Node.js >= 22 की आवश्यकता है। इसमें कोई रनटाइम निर्भरता नहीं है।

## पासा संकेतन

रोल, D&D, वर्ल्ड ऑफ़ डार्कनेस, शैडो रन, सैवेज वर्ल्ड्स, फेट और अन्य सहित पूर्ण Roll20/VTT संकेतन मानक का समर्थन करता है।

| संकेतन | अर्थ |
|----------|---------|
| `2d6` | दो छह-तरफा पासे रोल करें |
| `d20+5` | d20 रोल करें, संशोधक जोड़ें |
| `4d6kh3` | 4d6 रोल करें, सबसे अधिक 3 रखें |
| `4d6dl1` | 4d6 रोल करें, सबसे कम 1 को हटा दें |
| `1d6!` | विस्फोट (अधिकतम पर फिर से रोल करें, जोड़ें) |
| `1d6!>4` | 4 या उससे अधिक पर विस्फोट करें |
| `1d6!!` | संयोजन (एक ही पासे में विस्फोटों का योग) |
| `1d6!p` | भेदक (विस्फोट 1 घटाते हैं) |
| `2d6r<2` | 2 से कम मानों को फिर से रोल करें (असीमित) |
| `2d6ro=1` | 1 को एक बार फिर से रोल करें |
| `2d6min3` | तल: कोई भी पासा 3 से नीचे नहीं |
| `2d6max5` | छत: कोई भी पासा 5 से ऊपर नहीं |
| `8d6cs>=5` | सफलताएँ गिनें (पासे >= 5) |
| `8d6cs>=5cf<=1` | असफलताएँ घटाएँ |
| `1d20cs>19cf<2` | महत्वपूर्ण सफलता/विफलता का चिह्न |
| `4d6sa` / `4d6sd` | आरोही / अवरोही क्रम में सॉर्ट करें |
| `d%` | प्रतिशतक (1-100) |
| `4dF` | फेट/फज पासे |
| `(2d6+3)*2` | समूहन के साथ अंकगणित |

## सीएलआई उपयोग

```bash
roll 2d6+3                        # Basic roll
roll 8d6cs>=5                     # WoD-style dice pool
roll 4d6r<2min2kh3                # Complex modifier chain
roll 2d6 --analyze                # Full distribution + statistics
roll d20+5 --at-least 15          # P(result >= 15)
roll 2d6 --at-most 7              # P(result <= 7)
roll 2d6 --exactly 7              # P(result == 7)
roll 2d6 --between 6..8           # P(6 <= result <= 8)
roll 1d20+5 --target-for 0.65     # Largest target T with P(result >= T) >= 0.65
roll --compare "4d6dl1" "3d6"     # Side-by-side + P(A>B) verdict
roll --loot treasure.json         # Loot table
roll 2d6+3 --times 5              # Multiple rolls
roll 4d6kh3 --seed 42             # Deterministic, reproducible rolls
roll 2d6+3 --json                 # Machine-readable output
roll 2d6 --analyze --no-color     # Disable ANSI color for this run
```

### संभाव्यता प्रश्न

`--at-least` से परे, चार ध्वज उन प्रश्नों का उत्तर देते हैं जो एक डिज़ाइनर वास्तव में पूछता है। प्रत्येक एक स्वच्छ पंक्ति प्रिंट करता है और `--analyze` के समान सटीक/मोंटे-कार्लो लेबलिंग का सम्मान करता है:

| ध्वज | उत्तर |
|------|---------|
| `--at-least N` | P(परिणाम ≥ N) |
| `--at-most N` | P(परिणाम ≤ N) |
| `--exactly N` | P(परिणाम = N) |
| `--between L..H` | P(L ≤ परिणाम ≤ H) — यह `L,H` भी स्वीकार करता है |
| `--target-for P` | सबसे बड़ा लक्ष्य T इस प्रकार है कि P(परिणाम ≥ T) ≥ P ("65% समय तक हिट करने के लिए, लक्ष्य ≤ T") |

`--compare A B` अब दो आँकड़ों पर शीर्ष पर एक **वर्सेस** निर्णय जोड़ता है — P(A जीतता है), P(बराबर), P(B जीतता है), और माध्य अंतर E[A−B] — ताकि आप संतुलन प्रश्न को सीधे हल कर सकें। `--json` के साथ, इसमें एक `तुलना` ऑब्जेक्ट होता है (`pAGreater`, `pEqual`, `pBGreater`, `meanMargin`)।

### नियतात्मक रोल (`--seed`)

`--seed <int>` आरएनजी को सीड करता है ताकि एक रोल (या `--times N` अनुक्रम) बाइट-दर-बाइट पुनरुत्पादित हो — वह नियतिवाद जो इंजन, ब्रिज और एमसीपी में पहले से था, अब सीएलआई पर। बीज एक सीमित पूर्णांक होना चाहिए; एक खराब बीज त्रुटि उत्पन्न करेगा और 1 के साथ बाहर निकल जाएगा। एक **नकारात्मक** बीज पास करने के लिए, `=` रूप का उपयोग करें (`--seed=-3`), क्योंकि स्थान-पृथक अग्रणी डैश मान तर्क पार्सर के लिए अस्पष्ट है। `--json` `बीज` को प्रतिध्वनित करता है ताकि आउटपुट सटीक रूप से रिकॉर्ड करे कि इसने इसे कैसे उत्पन्न किया।

```bash
roll 4d6kh3 --seed 42             # same result every time
roll 1d20 --seed 7 --times 5      # a fixed, reproducible sequence of 5 rolls
roll 2d6 --seed 99 --json         # output includes "seed": 99
```

### रंग

डिफ़ॉल्ट रूप से रंग चालू होता है। इसे दो तरीकों से अक्षम करें:

- `--no-color` — एक एकल आह्वान के लिए ANSI स्टाइलिंग को दबाता है
- `NO_COLOR=1` (पर्यावरण चर) — [NO_COLOR](https://no-color.org/) मानक के अनुसार सम्मानित।

जब विश्लेषक बड़े या जटिल अभिव्यक्ति के लिए मोंटे कार्लो पर वापस चला जाता है, तो `--analyze` और `--at-ठीक` परिणाम को अनुमानित के रूप में लेबल करते हैं (नमूना गणना के साथ) सटीक संख्याओं को प्रस्तुत करने के बजाय। सटीक परिणामों को इस प्रकार नोट किया जाता है। `--json` आउटपुट में एक `विधि` फ़ील्ड होता है (`"सटीक"` या `"मोंटे-कार्लो"`, नमूने लेने पर `नमूने` के साथ) ताकि मशीन उपभोक्ता भी उन्हें अलग कर सकें।

### निकास कोड

रोल एक जानबूझकर दो-कोड अनुबंध का पालन करता है — एक स्थिरता वादा जिस पर स्क्रिप्ट निर्भर हो सकती हैं:

| कोड | अर्थ |
|------|---------|
| `0` | सफलता |
| `1` | कोई भी त्रुटि — खराब अभिव्यक्ति, सत्यापन विफलता, लापता लूट फ़ाइल, या एक सीमा पार करना |

त्रुटियाँ हमेशा stderr पर एक एकल स्वच्छ पंक्ति (कोड/संदेश/संकेत) प्रिंट करती हैं; सीएलआई कभी भी स्टैक ट्रेस लीक नहीं करता है।

## गेम टेबल

V2 मुठभेड़ों, महत्वपूर्णताओं, लूट, स्थिति प्रभावों और अधिक के लिए एक सार्वभौमिक गेम तालिका प्रणाली पेश करता है।

```typescript
import { rollGameTable } from '@mcptoolshop/roll';
import type { GameTableCollection } from '@mcptoolshop/roll';

const collection: GameTableCollection = {
  version: "2.0",
  tables: [{
    table: "critical_hits",
    kind: "critical",
    entries: [
      { name: "Devastating Blow", weight: 1, roll: "2d6", conditions: [{ type: "nat", operator: "=", value: 20 }] },
      { name: "Solid Hit", weight: 3, conditions: [{ type: "compare", operator: ">=", value: 15 }] },
      { name: "Glancing Blow", weight: 5 },
    ],
  }],
};

const results = rollGameTable(collection, "critical_hits", { triggerNat: 20, triggerRoll: 25 });
```

विशेषताएं: 8 तालिका प्रकार, भारित चयन, शर्तें (तुलना करें, नेट, टैग, संदर्भ), स्तर फ़िल्टरिंग, नेस्टेड टेबल, तालिका श्रृंखला, मात्रा/रोल/अवधि के लिए पासा अभिव्यक्ति, दुर्लभता स्तर, गोलाकार संदर्भ पहचान के साथ सत्यापन।

## लाइब्रेरी एपीआई

```typescript
import { roll, analyze } from '@mcptoolshop/roll';

// Roll with any V2 notation
const result = roll('8d6cs>=5');
console.log(result.total);                    // 3 (successes)
console.log(result.groups[0].resultMode);     // "success_count"
console.log(result.groups[0].dice);           // per-die breakdown with .critical markers

// Probability analysis — exact, not Monte Carlo
const analysis = analyze('8d6cs>=5');
console.log(analysis.stats.mean);             // 2.67
console.log(analysis.probabilityAtLeast(4));  // P(4+ successes)

// Seeded deterministic rolls
import { seededRng, parse, evaluate } from '@mcptoolshop/roll';
const ast = parse('4d6kh3');
const r = evaluate(ast, seededRng(42));       // reproducible
```

### स्थिरता

**उच्च-स्तरीय एपीआई स्थिर है** और सेमवर का पालन करता है — प्रमुख उछाल पर ही ब्रेकिंग परिवर्तन:

- `रोल`, `विश्लेषण`
- लूट एपीआई (`rollLootTable`, `validateLootTables`) और गेम-टेबल एपीआई (`rollGameTable`)
- `ब्रिजहैंडलर` JSON-RPC सतह

**निम्न-स्तरीय पार्सर आंतरिक उन्नत हैं और मामूली संस्करणों में बदल सकते हैं** — उनका उपयोग केवल तभी करें जब आपको स्वयं AST को चलने की आवश्यकता हो, और यदि आप उन पर निर्भर करते हैं तो एक संस्करण पिन करें:

- `टोकनाइज़`, `टोकन`, `टोकनटाइप`
- `रनपाइपलाइन`, `मैचेसकम्पेयर`

`विश्लेषण` `.विधि` (`"सटीक"` | `"मोंटे-कार्लो"`) और, नमूने वाले पथ के लिए, `.नमूने` भी रिपोर्ट करता है — ताकि कॉलर प्रोग्रामेटिक रूप से सटीक-संभाव्यता अनुबंध का सम्मान कर सकें।

## JSON ब्रिज (गॉडोट / अनरियल / रस्ट)

रोल में गेम इंजन एकीकरण के लिए चाइल्ड प्रक्रिया के माध्यम से JSON-RPC 2.0 ब्रिज शामिल है:

```bash
# Stdio mode (pipe JSON in, get JSON out)
echo '{"jsonrpc":"2.0","id":1,"method":"roll","params":{"expression":"4d6kh3","seed":42}}' | roll-bridge

# HTTP mode
roll-bridge --http --port 3947
curl -X POST http://localhost:3947/rpc -d '{"jsonrpc":"2.0","id":1,"method":"roll","params":{"expression":"2d6+3"}}'
```

विधियाँ: `रोल`, `रोल_बैच`, `विश्लेषण`, `एट_लीस्ट`, `तुलना करें`, `टेबल_रोल`, `टेबल_लोड`, `टेबल_लिस्ट`, `सीड`, `पिंग`, `शटडाउन`।

## एमसीपी सर्वर

रोल गेम डिज़ाइन के दौरान क्लाउड एकीकरण के लिए एमसीपी सर्वर के रूप में आता है:

```json
{
  "mcpServers": {
    "roll": {
      "command": "node",
      "args": ["node_modules/@mcptoolshop/roll/dist/mcp/server.js"]
    }
  }
}
```

5 उपकरण: `रोल_डाइस`, `विश्लेषण_डाइस`, `तुलना_डाइस`, `रोल_टेबल`, `क्वेरी_टेबल`।

## संभाव्यता इंजन

- बुनियादी एनडीएम के लिए बहुपद संवलन के माध्यम से **सटीक वितरण**
- कीप/ड्रॉप तंत्र के लिए **पूर्ण गणना** (4d6 = 1,296 अवस्थाएँ)
- **विश्लेषणात्मक रीरोल** - गैर-मिलान वाले फलकों पर संभावना द्रव्यमान का पुनर्वितरण करता है
- **विश्लेषणात्मक न्यूनतम/अधिकतम** - वितरण को छोटा करता है और क्लैंप पर द्रव्यमान जमा करता है
- **विश्लेषणात्मक सफलता गणना** - फलकों को +1/0/-1 में मैप करता है, एन बार संवलन करता है
- विस्फोटक/संयुक्त/प्रवेश करने वाले पासे के लिए **संक्षिप्त पुनरावर्तन**
- जब सटीक गणना 10 मिलियन अवस्थाओं से अधिक हो जाती है, तो **मोंटे कार्लो फॉलबैक** (100k नमूने)

प्रत्येक संशोधक में सटीक संभावना विश्लेषण होता है - केवल सिमुलेशन नहीं।

## सुरक्षा और विश्वास

यह पासे के भावों को संसाधित करता है और कुछ भी नहीं। कोई नेटवर्क अनुरोध नहीं, कोई फ़ाइल लेखन नहीं (केवल `--loot` एक JSON पढ़ता है), कोई टेलीमेट्री नहीं, कोई गुप्त जानकारी नहीं। सभी पासे के रोल क्रिप्टोग्राफ़िक यादृच्छिकता के लिए `crypto.randomInt` का उपयोग करते हैं। संसाधनों की कमी को रोकने के लिए भावों को पार्सिंग समय पर सीमित किया जाता है (पासे की संख्या, पासे के फलक, लंबाई), और `--loot` फ़ाइल से पढ़ी गई किसी भी पाठ को प्रदर्शित करने से पहले टर्मिनल नियंत्रण वर्णों से हटा दिया जाता है ताकि एक शत्रुतापूर्ण तालिका आपके टर्मिनल में एएनएसआई एस्केप अनुक्रम इंजेक्ट न कर सके।

भेद्यता रिपोर्टिंग नीति के लिए [SECURITY.md](./SECURITY.md) देखें।

## लाइसेंस

एमआईटी

---

<a href="https://mcp-tool-shop.github.io/">एमसीपी टूल शॉप</a> द्वारा निर्मित
