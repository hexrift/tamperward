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
