# howto-touch-free

Touch-free hand-gesture recognition for HowTo. Pure logic, no DOM, no camera:
feed it MediaPipe-style hand landmarks per frame, get gesture events back.

This repo is the single source of truth. Consumers:

- website: Arnonfr/how-to (git submodule / shim re-export)
- app: Arnonfr/how-to-app (pinned git dependency in package.json)
- Chrome extension: Arnonfr/how-to-extension (git submodule in vendor/)

Never copy gestures.js into a consumer repo. Improve it HERE, run the tests,
push, then bump the consumer pins.

Run the tests: `npm test`
