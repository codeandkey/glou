/*
 * remote_node.js
 *
 * glou interface for interacting with a remote node
 * communication is only partially handled here -- writers and readers have to be passed to the constructor
 *
 * this class does NOT manage socket connection state changes, it simply manages the node abstraction
 */

const {EventEmitter} = require('events');
const rl = require('readline');

class GlouRemoteNode extends EventEmitter {
    constructor(info, writer, local, logger) {
        super();

        this.info = info;
        this.uid = 0;
        this.reqs = {};
        this.services = {};
        this.writer = writer;
        this.local = local;

        this.logger = console.log;
        if (logger) this.logger = logger;

        this._log('initialized remote node interface');
    }

    /* check ID string matching */
    matches(str) {
        if (str[0] == '@') return (str.slice(1) == this.info.name);
        return (str == this.info.hash);
    }

    /* message handler */
    do_recv(md) {
        try {
            switch (md.type) {
            case 'response':
                return this.reqs[md.uid](md);
            case 'service':
                return this._handle_get_local_service(md);
            case 'call':
                return this._handle_call(md);
            }
        } catch (e) {
            this._log('error in received message: ' + e.stack);
        }
    }

    /* respond to call request */
    _handle_call(md) {
        let rsp = {
            type: 'response',
            status: 'ok',
            uid: md.uid,
        };

        this.local._call_local_service(md.name, md.fun, md.args, (err, ret) => {
            if (err) {
                rsp.status = err;
            } else {
                rsp.ret = ret;
            }

            return this._write(rsp);
        });
    }

    /* respond to request for service snapshot */
    _handle_get_local_service(md) {
        this.local._get_local_service(md.name, (err, d) => {
            let rsp = {
                type: 'response',
                status: 'ok',
                uid: md.uid,
            };

            if (err) {
                rsp.status = err;
            } else {
                rsp.body = d;
            }

            return this._write(rsp);
        });
    }

    /* request a SNAPSHOT of a service */
    request_service(name, cb) {
        const rq = {
            type: 'service',
            name: name,
        };

        this._req(rq, (rsp) => {
            if (rsp.status != 'ok') {
                return cb(rsp.status);
            }

            this.services[name] = rsp.body;
            return cb(null, rsp.body);
        });
    }

    /* get service list */
    get_service_list() {
        let out = [];
        for (var k in this.services) {
            if (this.services.hasOwnProperty(k)) {
                out.push(k);
            }
        }
        return out;
    }

    /* call remote service */
    call(name, fun, args, cb) {
        const rq = {
            type: 'call',
            name: name,
            fun: fun,
            args: args
        };

        this._req(rq, (rsp) => {
            if (rsp.status != 'ok') {
                return cb(rsp.status);
            }

            return cb(null, rsp.ret);
        });
    }

    /* request helper */
    _req(md, cb) {
        md.uid = this._uuid();
        this.reqs[md.uid] = (rsp) => {
            delete this.reqs[md.uid];
            return cb(rsp);
        };
        this._write(md);
    }

    _write(d) {
        this.writer(d);
    }

    /* logger passthrough */
    _log(m) {
        this.logger('(' + this.info.name + ':' + this.info.hash + ') ' + m);
    }

    /* partial info clash check */
    clashes(info) {
        return ((info.name == this.info.name) || (info.hash == this.info.hash));
    }

    /* unique nonce for requests */
    _uuid() {
        return this.uid++;
    }
}

module.exports = GlouRemoteNode;
