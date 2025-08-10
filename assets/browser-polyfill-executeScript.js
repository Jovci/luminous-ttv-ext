(function () {
  'use strict';

  const checkPolyfilled = 'typeof browser !== "undefined"';

  const _executeScript = chrome.tabs.executeScript;
  const withP = (...args) =>
    new Promise((resolve, reject) => {
      _executeScript(...args, (results) => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError.message);
        } else {
          resolve(results);
        }
      });
    });

  // @ts-expect-error FIXME: executeScript should return Promise<any[]>
  chrome.tabs.executeScript = (...args) => {
  (async () => {
      const baseArgs = (typeof args[0] === 'number' ? [args[0]] : []); 

      const [done] = await withP(...(baseArgs.concat({ code: checkPolyfilled }) ));

      if (!done) {
        await withP(...(baseArgs.concat([{ file: JSON.parse('"assets/browser-polyfill.js"') }]) ));
      }

      _executeScript(...(args ));
    })();
  };

}());
