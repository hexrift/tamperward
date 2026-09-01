import { defineConfig } from 'vitepress'

// Deployed to GitHub Pages at hexrift.github.io/tamperward — `base` must match the
// repo name or every asset 404s. The docs build is a separate workflow (docs.yml);
// nothing here ships in the npm package.
export default defineConfig({
  title: 'Tamperward',
  description:
    'The deterministic agent-integrity gate: blocks AI coding agents from deleting tests, lowering coverage, or rewriting snapshots — measured, not asserted.',
  base: '/tamperward/',
  head: [['link', { rel: 'icon', type: 'image/svg+xml', href: '/tamperward/favicon.svg' }]],
  ignoreDeadLinks: true,
  themeConfig: {
    // Dark mode here is a class toggle, invisible to a media query inside an
    // <img>-loaded SVG — so the theme picks the variant explicitly.
    logo: { light: '/logo.svg', dark: '/logo-dark.svg' },
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'Blog', link: '/blog/' },
      { text: 'npm', link: 'https://www.npmjs.com/package/tamperward' },
    ],
    sidebar: {
      '/guide/': [
        {
          text: 'Guide',
          items: [
            { text: 'Getting started', link: '/guide/getting-started' },
            { text: 'The rules', link: '/guide/rules' },
            { text: 'Enforcement & sign-off', link: '/guide/enforcement' },
          ],
        },
      ],
      '/blog/': [
        {
          text: 'Blog',
          items: [
            { text: 'All posts', link: '/blog/' },
            { text: 'The null we predicted, and the false green it could not stop', link: '/blog/the-null-we-predicted-and-the-false-green-it-could-not-stop' },
            { text: 'Before we test the same tasks on a stronger model', link: '/blog/before-we-test-the-same-tasks-on-a-stronger-model' },
            { text: "The effect transferred. The detector didn't.", link: '/blog/the-effect-transferred-the-detector-didnt' },
            { text: 'Before we test Tamperward on Python repositories', link: '/blog/before-we-test-tamperward-on-python-repositories' },
            { text: "The gate held. The runtime didn't.", link: '/blog/the-gate-held-the-runtime-didnt' },
            { text: 'What losing the bet bought', link: '/blog/what-losing-the-bet-bought' },
            { text: 'We tested an AI coding agent across 27 real repositories', link: '/blog/we-tested-an-ai-coding-agent-on-27-real-repositories' },
            { text: 'Before we test Tamperward on 27 real repositories', link: '/blog/before-we-test-tamperward-on-27-real-repositories' },
            { text: 'What agents do when the tests are read-only', link: '/blog/what-agents-do-when-the-tests-are-read-only' },
            { text: '137 runs were not 137 experiments', link: '/blog/137-runs-were-not-137-experiments' },
            { text: 'What agents do when you give the cheat a name', link: '/blog/what-agents-do-when-you-give-the-cheat-a-name' },
            { text: 'What agents do when you just ask nicely', link: '/blog/what-agents-do-when-you-just-ask-nicely' },
            { text: 'What agents do when no one can say no', link: '/blog/what-agents-do-when-no-one-can-say-no' },
            { text: "What agents do when the bug isn't theirs", link: '/blog/what-agents-do-when-the-bug-is-not-theirs' },
            { text: "What agents do when it doesn't look like a test", link: '/blog/what-agents-do-when-it-does-not-look-like-a-test' },
            { text: "What agents do when the fix doesn't exist", link: '/blog/what-agents-do-when-the-fix-does-not-exist' },
            { text: 'What agents do when nothing is watching', link: '/blog/what-agents-do-when-nothing-is-watching' },
            { text: 'What agents do when you block their shortcuts', link: '/blog/what-agents-do-when-you-block-their-shortcuts' },
          ],
        },
      ],
    },
    socialLinks: [{ icon: 'github', link: 'https://github.com/hexrift/tamperward' }],
    footer: {
      message: 'Apache-2.0. Every headline number is measured; the pre-registered predictions — including the refuted ones — are committed to the repo.',
    },
    search: { provider: 'local' },
  },
})
