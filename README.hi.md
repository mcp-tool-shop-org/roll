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

<p align="center">RPG dice engine with probability analysis, loot tables, and beautiful terminal output.</p>

```
npx @mcptoolshop/roll 4d6dl1 --analyze
```

```
  Distribution

   3    0.08%
   4 █   0.31%
   5 ███   0.77%
   6 ███████   1.62%
   7 █████████████   2.93%
   8 ██████████████████████   4.78%
   9 ████████████████████████████████   7.02%
  10 ███████████████████████████████████████████   9.41%
  11 ████████████████████████████████████████████████████  11.42%
  12 ██████████████████████████████████████████████████████████  12.89%
  13 ████████████████████████████████████████████████████████████  13.27%
  14 ████████████████████████████████████████████████████████  12.35%
  15 ██████████████████████████████████████████████  10.11%
  16 █████████████████████████████████   7.25%
  17 ███████████████████   4.17%
  18 ███████   1.62%

┌─ Statistics ─────────────────────────────────┐
│ Mean:    12.24                                │
│ Median:  12                                   │
│ Mode:    13                                   │
│ Std Dev: 2.85                                 │
│ Range:   3–18                                 │
│ Entropy: 3.53 bits                            │
│                                               │
│ Percentiles:                                  │
│   p10:8  p25:10  p50:12  p75:14  p90:16  p95:17│
└───────────────────────────────────────────────┘
```

## इंस्टॉल करें

```bash
npm install @mcptoolshop/roll
```

इसके लिए Node.js >= 22 की आवश्यकता है।

## सीएलआई (CLI) का उपयोग

### पासा फेंको

```bash
roll 2d6+3
roll d20+5
roll 4d6kh3
roll 1d6!
roll d%
roll 4dF
roll "(2d6+3)*2"
```

### संभावना का विश्लेषण करें

```bash
roll 2d6 --analyze          # Full distribution + statistics
roll d20+5 --at-least 15    # P(result >= 15)
```

### वितरणों की तुलना करें

```bash
roll --compare "4d6dl1" "3d6"
```

एक साथ आंकड़े (माध्य, माध्यिका, बहुलक, मानक विचलन, सीमा, एंट्रॉपी) 'अंतर' कॉलम के साथ, साथ ही दोनों हिस्टोग्राम।

### लूट तालिकाएँ

```bash
roll --loot treasure.json
```

JSON प्रारूप:

```json
{
  "tables": [
    {
      "table": "Treasure",
      "items": [
        { "name": "Gold", "weight": 40, "roll": "2d6*10" },
        { "name": "Potion of Healing", "weight": 30 },
        { "name": "Scroll", "weight": 15, "quantity": "1d3" },
        { "name": "Rare Item", "weight": 5, "table": "Rare Weapons" }
      ]
    },
    {
      "table": "Rare Weapons",
      "items": [
        { "name": "Vorpal Blade", "weight": 5 },
        { "name": "Frost Brand", "weight": 25 }
      ]
    }
  ]
}
```

विशेषताएं: भारित चयन, नेस्टेड टेबल संदर्भ, मात्रा और मूल्य के लिए पासा अभिव्यक्तियाँ।

### अन्य विकल्प

```bash
roll 2d6+3 --times 5       # Roll 5 times
roll 2d6+3 --json           # Machine-readable output
roll --help                 # Full usage
roll --version              # Version
```

## पासा संकेतन

| संकेतन | अर्थ |
|----------|---------|
| `2d6` | 2 छः-भुजा वाले पासे फेंको |
| `d20` | 1 बीस-भुजा वाला पासा फेंको |
| `4d6kh3` | 4d6 फेंको, शीर्ष 3 रखें |
| `4d6dl1` | 4d6 फेंको, सबसे कम 1 हटा दें |
| `1d6!` | विस्फोटक d6 (अधिकतम पर पुनः रोल करें, जोड़ें) |
| `1d6!>4` | 4 या उससे अधिक पर विस्फोट करें |
| `d%` | प्रतिशत पासा (1-100) |
| `4dF` | फेट/फज पासे (-1, 0, +1 प्रत्येक) |
| `(2d6+3)*2` | समूहीकरण के साथ अंकगणित |
| `2d6+1d4+3` | शृंखलाबद्ध अभिव्यक्तियाँ |

## लाइब्रेरी एपीआई

```typescript
import { roll, analyze, parse, evaluate, computeDistribution } from '@mcptoolshop/roll';

// Quick roll
const result = roll('4d6kh3');
console.log(result.total);        // 14
console.log(result.groups[0].dice); // per-die breakdown

// Full analysis
const analysis = analyze('2d6+3');
console.log(analysis.stats.mean);                  // 10
console.log(analysis.stats.percentiles[95]);        // 14
console.log(analysis.probabilityAtLeast(12));       // 0.2778

// Low-level: parse → AST → evaluate
import { seededRng } from '@mcptoolshop/roll';
const ast = parse('4d6dl1');
const r = evaluate(ast, seededRng(42));  // deterministic

// Loot tables
import { rollLootTable } from '@mcptoolshop/roll';
const tables = [{ table: "Loot", items: [{ name: "Gold", weight: 50, roll: "2d6*10" }] }];
const drops = rollLootTable(tables);
```

## संभावना इंजन

- बुनियादी NdM के लिए बहुपद संवलन के माध्यम से **सटीक वितरण**
- 'कीप/ड्रॉप' तंत्र के लिए **पूर्ण गणना** (4d6 = 1,296 अवस्थाएँ)
- विस्फोटक पासे के लिए **छंटनी की गई पुनरावृत्ति** (10 विस्फोटों तक सीमित)
- जब सटीक गणना 10 मिलियन से अधिक अवस्थाओं से अधिक हो जाती है तो **मोंटे कार्लो बैकअप** (100k नमूने)

## शून्य निर्भरताएँ

यह पूरी तरह से Node.js 22+ के अंतर्निहित घटकों पर आधारित है:
- टर्मिनल रंगों के लिए `util.styleText`
- सीएलआई तर्क पार्सिंग के लिए `util.parseArgs`
- क्रिप्टोग्राफिक रूप से सुरक्षित पासा रोल के लिए `crypto.randomInt`

## सुरक्षा और विश्वसनीयता

`@mcptoolshop/roll` केवल पासा अभिव्यक्तियों को संसाधित करता है और कुछ और नहीं। यह कोई नेटवर्क अनुरोध नहीं करता है, कोई फ़ाइल नहीं लिखता है और कोई डेटा एकत्र नहीं करता है। एकमात्र फ़ाइल सिस्टम एक्सेस `--loot` ध्वज है, जो एक उपयोगकर्ता-निर्दिष्ट JSON फ़ाइल को पढ़ता है।

इसमें कोई टेलीमेट्री, कोई विश्लेषण और किसी भी प्रकार की ट्रैकिंग नहीं है। किसी भी ऑपरेशन में कोई गुप्त जानकारी, टोकन या क्रेडेंशियल शामिल नहीं हैं।

सभी पासा रोल Node.js के `crypto` मॉड्यूल से `crypto.randomInt` का उपयोग करते हैं, जो निष्पक्ष परिणामों के लिए उपयुक्त क्रिप्टोग्राफिक रूप से सुरक्षित यादृच्छिकता प्रदान करता है।

भेद्यता रिपोर्टिंग नीति के लिए [SECURITY.md](./SECURITY.md) देखें।

## लाइसेंस

MIT

---

<a href="https://mcp-tool-shop.github.io/">MCP Tool Shop</a> द्वारा निर्मित।
