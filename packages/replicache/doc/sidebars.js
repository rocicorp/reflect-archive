const {toEditorSettings} = require('typescript');

module.exports = {
  docs: [
    // TODO clean out the unused docs
    {
      'Get Started': [
        {
          'Hello, Replicache': [
            'tutorial/introduction',
            'tutorial/constructing-replicache',
            'tutorial/adding-mutators',
            'tutorial/subscriptions',
            'tutorial/sync',
            'tutorial/next-steps',
          ],
        },
        'quickstarts',
        {
          'Build Your Own Backend': [
            'byob/intro',
            'byob/install-replicache',
            'byob/design-client-view',
            'byob/render-ui',
            'byob/local-mutations',
            'byob/database-setup',
            'byob/database-schema',
            'byob/remote-mutations',
            'byob/dynamic-pull',
            'byob/poke',
            'byob/conclusion',
          ],
        },
      ],
    },
    {
      Examples: ['examples/todo', 'examples/repliear', 'examples/replidraw'],
    },
    {
      'Understand Replicache': [
        'concepts/how-it-works',
        'concepts/performance',
        'concepts/offline',
        'concepts/consistency',
        'concepts/faq', // TODO review
        // TODO what replicache is good for
      ],
    },
    {
      Reference: [
        {
          'JavaScript Reference': [
            {
              type: 'autogenerated',
              dirName: 'api', // 'api' is the 'out' directory
            },
          ],
        },
        'reference/server-push',
        'reference/server-pull',
      ],
    },
    {
      HOWTO: [
        'howto/licensing',
        'howto/blobs',
        'howto/share-mutators',
        'howto/launch',
        //'howto/undo',
      ],
    },
  ],
};