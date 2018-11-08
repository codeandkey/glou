const node = require('./src/glou.js')('TestService');

node.on('start', () => {
    node.provide({a: 1, b: 2, c: (e) => { return e*2; }});
    node.node('@0x220.glou', (err, n) => {
        if (err) return console.log(err);
        n.service('TestService', (err, svc) => {
            if (err) return console.log(err);
            console.log(svc);
            svc.c((ret) => { console.log(ret); }, 4);
        });
    });
});

node.start();
