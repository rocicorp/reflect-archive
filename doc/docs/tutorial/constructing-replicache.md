---
title: Constructing Replicache
slug: /tutorial/constructing-replicache
---

<iframe src="https://codesandbox.io/embed/replicache-constructing-zh7uvb?hidenavigation=1&autoresize=1&fontsize=12&hidenavigation=0&theme=light&codemirror=1&view=split"
     style={{'width':'100%','height':'350px', 'border':'1px solid rgb(222,221,221)', 'overflow':'hidden'}}
     title="constructing-replicache"
     allow="accelerometer; ambient-light-sensor; camera; encrypted-media; geolocation; gyroscope; hid; microphone; midi; payment; usb; vr; xr-spatial-tracking"
     sandbox="allow-forms allow-modals allow-popups allow-presentation allow-same-origin allow-scripts"
></iframe>

The Replicache constructor requires `name` and `licenseKey`.

Replicache stores data persistently in the browser using [IndexedDB](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API). Instances that have the same `name` share storage. You should typically use the logged-in user's ID as the `name`, to keep their storage separate from any other users on the same device.

For licenseKey, you can use the `TEST_LICENSE_KEY` as this sample does, which works for up to five minutes.

<h2>Challenge</h2>

To use Replicache for longer, [get your own license key](/howto/licensing) and use it here instead of `TEST_LICENSE_KEY`.

<div style={{fontSize:"1.2em", fontWeight:"bold", marginTop:"3em"}}><a href="/tutorial/adding-mutators">Next: Mutators &rarr;</a></div>