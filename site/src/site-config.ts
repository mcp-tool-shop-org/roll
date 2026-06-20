import type { SiteConfig } from '@mcptoolshop/site-theme';

export const config: SiteConfig = {
  title: 'Roll',
  description: 'RPG dice engine — expression parser, probability analyzer, loot tables, beautiful terminal output',
  tagline: 'Parse any dice expression. Analyze the odds. Roll with confidence.',
  logoBadge: '🎲',
  brandName: 'roll',
  repoUrl: 'https://github.com/mcp-tool-shop-org/roll',
  npmUrl: 'https://www.npmjs.com/package/@mcptoolshop/roll',
  footerText: 'MIT Licensed — built by <a href="https://github.com/mcp-tool-shop-org" style="color:var(--color-muted);text-decoration:underline">mcp-tool-shop-org</a>',

  hero: {
    badge: 'Zero dependencies',
    headline: 'Roll',
    headlineAccent: 'dice engine.',
    description: 'Full dice expression parser, exact probability analysis, loot table roller, and beautiful terminal output — in one package.',
    primaryCta: { href: '#usage', label: 'Get started' },
    secondaryCta: { href: 'handbook/', label: 'Read the Handbook' },
    previews: [
      { label: 'Install', code: 'npm install @mcptoolshop/roll' },
      { label: 'CLI', code: 'npx @mcptoolshop/roll 4d6dl1 --analyze' },
      { label: 'Library', code: "import { roll, analyze } from '@mcptoolshop/roll'" },
    ],
  },

  sections: [
    {
      kind: 'features',
      id: 'features',
      title: 'Features',
      subtitle: 'Everything a game designer needs in one package.',
      features: [
        { title: 'Full Notation', desc: '2d6, 4d6kh3, 1d6!, d%, 4dF — every expression you need, parsed by a recursive descent engine.' },
        { title: 'Probability Analysis', desc: 'Exact distributions via convolution and enumeration — and honest about it: every result is labeled exact or Monte-Carlo.' },
        { title: 'Which Build Wins?', desc: 'Compare two expressions as a probability contest — P(A wins), P(tie), P(B wins), and the mean margin.' },
        { title: 'Table Analysis', desc: "Read every entry's real drop odds without rolling. Legendary: 2%. Dragon: 0% (minLevel 12). Excluded entries explained." },
        { title: 'Loot Tables', desc: 'Weighted selection, nested table references, integrated dice expressions for quantity and value.' },
        { title: 'Zero Dependencies', desc: 'Built entirely on Node.js 22+ builtins. Cryptographic randomness via crypto.randomInt. 509 tests.' },
        { title: 'Dual-Use', desc: 'CLI via npx for quick rolls. Library, JSON-RPC bridge, and MCP server for engines, bots, and Claude.' },
      ],
    },
    {
      kind: 'code-cards',
      id: 'usage',
      title: 'Usage',
      cards: [
        { title: 'Roll dice', code: 'npx @mcptoolshop/roll 2d6+3\nnpx @mcptoolshop/roll 4d6kh3\nnpx @mcptoolshop/roll 1d6!' },
        { title: 'Analyze odds', code: 'npx @mcptoolshop/roll 4d6dl1 --analyze\nnpx @mcptoolshop/roll 2d6 --between 6..8\nnpx @mcptoolshop/roll 1d20+5 --target-for 0.65\nnpx @mcptoolshop/roll --compare "2d6+5" "1d12+6"' },
        { title: 'Library API', code: "import { roll, analyze } from '@mcptoolshop/roll';\n\nconst result = roll('4d6kh3');\nconsole.log(result.total);\n\nconst { stats } = analyze('2d6+3');\nconsole.log(stats.mean);" },
        { title: 'Loot tables', code: "import { rollLootTable } from '@mcptoolshop/roll';\n\nconst tables = [{\n  table: 'Treasure',\n  items: [\n    { name: 'Gold', weight: 40, roll: '2d6*10' },\n    { name: 'Potion', weight: 30 }\n  ]\n}];\nconst drops = rollLootTable(tables);" },
      ],
    },
  ],
};
