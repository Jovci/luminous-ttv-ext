(function () {
	'use strict';

	const importPath = /*@__PURE__*/JSON.parse('"../ts/content.js"');

	import(chrome.runtime.getURL(importPath));

}());
