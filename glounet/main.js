/*
 * main.js
 *
 * glounet node entry point
 */

const os = require('os');
const GlouNode = require('./src/node.js');

const args = process.argv.slice(2);
let name = os.hostname() + '.glou';

if (args.length > 0) {
    name = args[0];
}

let gnode = new GlouNode(name);

gnode.on('error', (e) => {
    console.log('node error: ' + e);
    process.exit(1);
});

gnode.on('start', () => {
    console.log('glou node started');
});

gnode.start();
