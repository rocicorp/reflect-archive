# Releasing Reflect

## Write Release Notes

Clone the latest Release Note doc from [Notion](https://www.notion.so/replicache/Release-Notes-43b93bd9bf774de6a505247a6e7a3fb8) and add a new one for the next release. Label it "(wip)" while working on it since this directory is publicly visible.

## Determine minor/patch release

- minor if there are breaking changes
- patch otherwise

## If minor version, then commit a change that bumps the version to 0.<newminorversion>.0.

## Cut a canary

Run `node ./packages/reflect/tool/create-canary.js`

This builds Reflect, tests it, tags it, pushes the tag, pushes to npm, and pushes to mirror 🤯.

After this runs you have to manually merge the tag into main. The output says how. Don't forget to do that.

# Test a Release

## Docs

Follow the instructions at https://hello.reflect.net/scaffold and https://hello.reflect.net/add-to-existing except use @$NEW_VERSION instead of @latest.

## Examples

Checkout each of the examples at https://hello.reflect.net/start/examples.

Install the new version from npm:

```
npm install @rocicorp/reflect@canary
```

Follow instructions in repo to finish setting up app, and run to make sure it works.

For canary releases you may need to make changes to the app to allow it work, or to adopt newer features. Publish these to a WIP PR which we can update until release.

# Update documentation

- Make a PR for any doc changes/additions, but don't land it.

# Release an Official Build

- Use `npm dist-tags` to make the new version @stable and @rec.
- Release new build to stable on mirror:
  - cd mirror/mirror-cli
  - npm run mirror releaseServer -- --server=0.x.y --channels=stable
- Land docs changes
- Land samples
