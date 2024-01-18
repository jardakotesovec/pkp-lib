function getComponentName(fullPath) {
	// Replace backslashes with forward slashes, then split
	let fileName = fullPath.replace(/\\/g, '/').split('/').pop();

	// Find the last dot in the filename
	const lastDotIndex = fileName.lastIndexOf('.');

	// If a dot was found, remove the extension
	if (lastDotIndex > 0) {
		fileName = fileName.substring(0, lastDotIndex);
	}

	return fileName;
}

function addComponentNames(componentName, html) {
	let depth = 0;
	let path = [];

	return html.replace(
		/<\/?div([ >\n])/g,
		(match, attributes, offset, string) => {
			if (match.startsWith('</div')) {
				// Closing div tag
				depth--;
				return match.replace('div', 'idiv');
			} else {
				// Opening div tag
				path.push(0);

				path[depth]++;

				path = path.slice(0, depth + 1);
				let divId = `idiv=${componentName}_${path.join('_')}`;
				depth++;

				return `<idiv ${divId} ${attributes}`;
			}
		},
	);
}
function enhanceIDivs() {
	return {
		name: 'enhanceIDivs',
		transform(code, id) {
			if (
				!id.includes('node_modules') &&
				(id.endsWith('.vue') || id.endsWith('.js'))
			) {
				const componentName = getComponentName(id);
				return {code: addComponentNames(componentName, code), map: null};
			}
		},
	};
}

module.exports = enhanceIDivs;
