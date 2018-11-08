/*
 * glou.js
 *
 * application-layer interface with a glou node
 * provides all necessary indirection and event handling
 */

const net = require('net');
const rl = require('readline');
const {EventEmitter} = require('events');

/* abstraction around a glou node -- could be the local node */
class GlouRemoteNode {
    constructor(pglou, remote, services) {
        this.pglou = pglou;
        this.remote = remote;
        this.services = services;
    }

    /* get a snapshot of a service on the node */
    service(name, cb) {
        const md = {
            type: 'service',
            remote: this.remote,
            name: name,
        };

        this.pglou._req(md, (rsp) => {
            if (rsp.status != 'ok') {
                return cb(rsp.status);
            }

            return cb(null, this._make_service(name, rsp.body));
        });
    }

    /* make service interface from provider template */
    _make_service(name, d) {
        if (typeof d === 'string' && d[0] == '$') {
            /* create wrapper function and swap it in-place */
            return (cb, ...args) => {
                this._call(name, d, cb, args);
            }
        }

        if (typeof d === 'object') {
            /* recursively traverse the whole object and children */
            for (var k in d) {
                if (d.hasOwnProperty(k)) {
                    d[k] = this._make_service(name, d[k]);
                }
            }
        }

        return d;
    }

    _call(name, d, cb, args) {
        const rq = {
            type: 'call',
            remote: this.remote,
            name: name,
            fun: d,
            args: args,
        };

        this.pglou._req(rq, (rsp) => {
            if (rsp.status != 'ok') {
                return this.pglou._log('error in call: ' + this.remote + ':' + name + ':' + d + ' ' + rsp.status);
            }

            return cb(rsp.ret);
        });
    }
}

class Glou extends EventEmitter {
    constructor(name, conf) {
        super();

        this.conf = {
            sockpath: '/tmp/glou.sock',
            verbose: true,
            reconnect_interval: 5000,
            watch_interval: 1500,
        };

        this.name = name;
        this.funcs = [];
        this.conn = null;
        this.user_providing = {};
        this.out_providing = {};
        this.uid = 0;
        this.resp_handlers = {};
        this.rci = null;

        if (conf) {
            this.conf = Object.assign(this.conf, conf);
        }
    }

    provide(obj) {
        /* check if we need to perform an update */
        if (this._cmpobj(obj, this.user_providing)) {
            this._log('skipping update with identical data');
        }

        /* scan the provided object and transform function IDs but keep object values */
        this.funcs = [];

        this.user_providing = obj;
        this.out_providing = this._scan(obj);

        this._log('providing: \n' + JSON.stringify(this.out_providing, null, 8));

        const md = {
            type: 'provide',
            body: this.out_providing,
        };

        this._write(md);
    }

    /* get node interface by @name or hash */
    node(id, cb) {
        const rq = {
            type: 'remote',
            remote: id,
        };

        this._req(rq, (rsp) => {
            if (rsp.status != 'ok') {
                return cb(rsp.status);
            }

            return cb(null, new GlouRemoteNode(this, id, rsp.list));
        });
    }

    /* periodically watch an object for modification and provide it */
    watch(obj) {
        setInterval(() => {
            this.provide(obj);
        }, this.conf.watch_interval);
    }

    /* initialize connection to local node and try to register service */
    start() {
        this._log('connecting to local node as service ' + this.name + '..');

        if (!this.rci) {
            this.rci = setInterval(() => { if (!this.conn) this.reconnect(); }, this.conf.reconnect_interval);
        }

        this.conn = net.connect(this.conf.sockpath, () => {
            this._log('connected to ' + this.conf.sockpath);
            let iface = rl.createInterface(this.conn, this.conn);

            iface.once('line', (d) => {
                try {
                    let md = JSON.parse(d);
                    if (md.type != 'hello') throw 'unexpected message ' + md.type;
                    this.info = md.info;

                    this._log('completed initial connection to local node ' + md.info.name + ':' + md.info.hash);

                    iface.on('line', (d) => {
                        try {
                            this._handle_msg(JSON.parse(d));
                        } catch (e) {
                            this._log('unexpected error in incoming message: ' + e);
                        }
                    });

                    this.emit('start');
                } catch (e) {
                    this._log('error initializing connection: ' + e);
                    this.conn.destroy();
                    this.conn = null;
                }
            });

            /* send service hello */
            const md = {
                type: 'hello',
                name: this.name,
                init: this.out_providing,
            };

            this._write(md);
        });

        this.conn.on('close', () => {
            this._log('disconnected from local node');
            this.conn = null;
        });

        this.conn.on('error', (e) => {
            this._log('local node socket error: ' + e);
            this.conn = null;
        });
    }

    /* conditional reconnect */
    reconnect() {
        this._log('trying to reconnect..');
        this.start();
    }

    /* message handler for incoming node messages */
    _handle_msg(md) {
        switch (md.type) {
        case 'hello':
            this.nodeinfo = md.info;
            this._log('connection ready with local node ' + md.info.name + ':' + md.info.hash);
            this.emit('start');
            break;
        case 'response':
            if (md.uid in this.resp_handlers) {
                this.resp_handlers[md.uid](md);
                delete this.resp_handlers[md.uid];
            }
            break;
        case 'call':
            const rsp = {
                type: 'response',
                status: 'ok',
                uid: md.uid,
            };

            this._call(md.fun, md.args, (err, ret) => {
                if (err) {
                    rsp.status = err;
                } else {
                    rsp.ret = ret;
                }

                this._write(rsp);
            });
            break;
        case 'error':
            this._log('local node reported error: ' + md.desc);
            break;
        }
    }

    /* deep object comparison */
    _cmpobj(a, b) {
        if (!(a instanceof Object) || !(b instanceof Object)) return (a == b); 

        for (var k in a) {
            if (a.hasOwnProperty(k)) {
                if (!b.hasOwnProperty(k)) return false;
                if (!this._cmpobj(a[k], b[k])) return false;
            }
        }

        /* we have to walk through both object keys to avoid subset false positives */

        for (var k in b) {
            if (b.hasOwnProperty(k)) {
                if (!a.hasOwnProperty(k)) return false;
                if (!this._cmpobj(b[k], a[k])) return false;
            }
        }

        return true;
    }

    /* recursive provider object transform */
    _scan(obj) {
        if (obj instanceof Function) {
            this.funcs.push(obj);
            return '$' + (this.funcs.length - 1);
        }

        if (obj instanceof Object) {
            let lop = {};

            for (var k in obj) {
                if (obj.hasOwnProperty(k)) {
                    lop[k] = this._scan(obj[k]);
                }
            }

            return lop;
        }

        return obj;
    }

    /* helper function, set a UID and request w/callback */
    _req(md, cb) {
        let reqid = this._uuid();
        md.uid = reqid;

        this.resp_handlers[reqid] = cb;
        this._write(md);
    }

    /* kinda asynchronous call */
    _call(fun, args, cb) {
        try {
            return cb(null, this.funcs[parseInt(fun.slice(1))](...args));
        } catch (e) {
            return cb(e);
        }
    }

    /* internal logging */
    _log(s) {
        if (!this.conf.verbose) return;
        console.log('[' + new Date().toLocaleTimeString() + '] glou: ' + s);
    }

    /* uuid gen */
    _uuid() {
        return this.uid++;
    }

    /* outgoing message helper */
    _write(obj) {
        if (!this.conn) {
            this._log('no connection! ignoring write');
        }

        this.conn.write(JSON.stringify(obj) + '\n');
    }
}

module.exports = (name) => {
    return new Glou(name);
};
