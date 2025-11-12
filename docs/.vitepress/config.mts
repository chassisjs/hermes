import { defineConfig } from 'vitepress'

// https://vitepress.dev/reference/site-config
export default defineConfig({
  title: 'Hermes',
  description: 'Production-ready implementation of the Outbox Pattern in TypeScript',
  head: [
    ['link', { rel: 'icon', type: 'image/x-icon', href: '/favicon.ico' }],
    ['link', { rel: 'icon', type: 'image/png', sizes: '32x32', href: '/favicon-32x32.png' }],
    ['link', { rel: 'icon', type: 'image/png', sizes: '16x16', href: '/favicon-16x16.png' }],
  ],
  themeConfig: {
    // https://vitepress.dev/reference/default-theme-config
    logo: '/logo-main.png',
    nav: [
      { text: 'Home', link: '/' },
      { text: 'Documentation', link: '/pages/what-is-hermes' },
      {
        text: 'Release Notes',
        link: 'https://github.com/chassisjs/hermes/releases',
      },
    ],

    sidebar: [
      { text: 'What is Hermes', link: '/pages/what-is-hermes.md' },
      { text: 'Getting Started', link: '/pages/getting-started.md' },
      { text: 'Every* system is distributed (essey)', link: 'https://www.knowhowcode.dev/articles/outbox/' },
      {
        text: 'PostgreSQL',
        items: [
          { text: 'How does it work?', link: '/pages/postgresql/how-does-it-work.md' },
          { text: 'Quick start', link: '/pages/postgresql/quick-start.md' },
          { text: 'PostgreSQL: Patient Registration', link: '/pages/postgresql-patient-registration.md' },
          { text: 'RabbitMQ Examples', link: '/pages/rabbitmq.md' },
          { text: 'Apache Pulsar Examples', link: '/pages/pulsar.md' },
          { text: 'Limitations', link: '/pages/postgresql/limitations.md' },
          { text: 'API docs', link: 'https://docs.hermesjs.tech/hermes-postgresql/index.html' },
        ],
      },
      {
        text: 'MongoDB',
        items: [
          { text: 'How does it work?', link: '/pages/mongodb/how-does-it-work.md' },
          { text: 'Basic usage', link: '/pages/mongodb/basic-usage.md' },
          { text: 'MongoDB: Medicine Assignment', link: '/pages/mongodb-medicine-assignment.md' },
          { text: 'Limitations', link: '/pages/mongodb/limitations.md' },
          { text: 'API docs', link: 'https://docs.hermesjs.tech/hermes-mongodb/index.html' },
        ],
      },
      {
        text: 'Others',
        items: [{ text: 'Useful links', link: '/pages/links.md' }],
      },
    ],

    socialLinks: [{ icon: 'github', link: 'https://github.com/chassisjs/hermes' }],
    footer: {
      copyright: 'Copyright © Artur Wojnar and contributors.',
    },
  },
})
