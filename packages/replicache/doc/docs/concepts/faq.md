---
title: Frequently Asked Questions
slug: /concepts/faq
---

import TOCInline from '@theme/TOCInline';

<TOCInline toc={toc} />

## How does the client know when to sync? Does it poll?

Typically, servers send a _poke_ (a content-less hint) over a websocket to tell the client to sync. There are many services you can use for this, and since no content flows over the socket there is no security/privacy concern. See the [integration guide](/byob/poke) for more information.

Replicache also polls at a low interval (60s by default) in case the poke mechanism fails or for applications that don't require low latency updates. You can adjust this using the [`pullInterval`](api/interfaces/ReplicacheOptions#pullInterval) field.

## What if I don’t have a dedicated backend? I use serverless functions for my backend

No problem. You can implement the integration points as serverless functions. Our samples are all implemented this way.

## How can I programmatically prevent Replicache from syncing?

Options:

- Set `pullURL` and `pushURL` to `undefined`. These are read/write so clearing them prevents next push/pull.
- Set a large delay: setting a large `pushDelay` will prevent automatically pushing after a mutation. Setting `pullInterval` will increase the time to the next pull.
- You could implement a custom `puller`/`pusher`.

If you would like better / more first-class support for this please [file an issue](https://github.com/rocicorp/replicache/issues/new).

## How can I tell if Replicache has unpushed local mutations? {#unpushed}

Replicache doesn't currently have first-class support for this. It is possible to implement an "unconfirmed changes" monitor using the Client View, by keeping your own mutation sequence number and having the server include its high-water mark in the Client View. If you would like better / more first-class support for this please [file an issue](https://github.com/rocicorp/replicache/issues/new).

## Do you support collaborative text editing?

We don't have first-class support for collaborative-text yet.

Some users implement collaborative text elements within a Replicache applications by sending [Yjs](https://github.com/yjs/yjs) documents over push and pull. This works fairly well. It's easy to send just deltas upstream via Replicache mutations. For downstream, sending just deltas is more difficult. Current users we are aware of just send the whole document which is fine for smaller documents.

Many applications can also get by without a full collaborative editing solution if their text is highly structured (e.g., like Notion).

We do plan to offer first-class collaborative text in the future.

## How can I implement presence?

Replicache is a general purpose synchronization system. It doesn't have a first-class concept of presence, but it is easy to build one that works exactly how you want. See [Replidraw](https://github.com/rocicorp/replidraw) for an example.

## What is a Monthly Active Profile?

A monthly active profile (MAP) is how we charge for Replicache. Specifically it's a unique browser profile that used your application during a month.

For example, if within one month, one of your users used your Replicache-enabled app on Firefox and Chrome on their Desktop computer and Safari on their phone, that would be 3 MAPs.

The reason for counting this way is because as a client-side JavaScript library, Replicache is sandboxed within a browser profile. It can't tell the difference between two profiles on the same machine or two profiles on different machines.

MAPs are typically a small fraction (like 50%) higher than MAUs because some users, but not all, use applications on multiple profiles/devices.

## What do you mean by Commercial Application?

This is defined by the [Rocicorp Terms of Service](https://roci.dev/terms.html).

## Can you give me some billing examples?

Yes!

- Example 1: You are a non-profit organization with 4M MAPs. **Your price is zero**.
- Example 2: You are using Replicache for a personal blog with 5k MAPs. **Your price is zero**.
- Example 3: You are a startup using Replicache for a revolutionary productivity application. You have raised a seed of $150k and have $100k annual revenue. **Your price is zero**.
- Example 4: You are using Replicache for a new version of your company's SaaS offering, but it's in internal testing and has only 50 MAPs (your dev team). You have been using Replicache for more than 2 months. Your company has raised $600k in total funding, but you are pre-revenue. **Your price is $500/mo**.
- Example 5: You are using Replicache for a new product that is a free add-on to your company's SaaS offering. You have been using Replicache for more than 2 months and are generating 15k MAPs. Your company is bootstrapped and making $300k/yr. **Your price is $3000/mo**.

If you are not sure if your application is commercial or not, [drop us a line](https://replicache.dev/#contact).

## Can I get access to the source code?

Yes! We do offer source licenses to commerical users. [Let us know](https://replicache.dev/#contact) if you are interested.