# reflect-scaffold-example

This project will set you up with a very basic application that you can immediately publish and see working utilizing reflect.

## To Run

```bash
npm run watch
```

## To Publish

```bash
# Publish the Reflect server
npx reflect publish --app=my-app

# Publish the UI somewhere, i.e. Vercel.
# You will need to set the environment variable VITE_REFLECT_URL to whatever
# `npx reflect publish` output above.
npx vercel
```
