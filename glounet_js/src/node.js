const net = require('net');
const crypto = require('crypto');
const dgram = require('dgram');
const {EventEmitter} = require('events');
const fs = require('fs');
const rl = require('readline');
const GlouRemoteNode = require('./remote_node.js');
const Key = require('./key.js');

class GlouNode extends EventEmitter {
    constructor(name, conf) {
        super();

        this.info = {
            name: name,
            hash: '<FIXME hash>',
        };

        this.uuid = 0;
        this.resp_handlers = {};
        this.services = {};
        this.service_socks = {};
        this.network = [];
        this.bci = null;

        this.key = new Key();
        this.info.hash = this.key.hash;

        this.conf = {
            sockpath: '/tmp/glou.sock',
            tcp_port: 5135,
            udp_port: 5145,
            bc_interval: 5000,
            kdf_digest: 'sha512',
            kdf_iterations: 2048,
            skey_len: 32,
            salt_len: 16,
            ecdh_curve: 'prime256v1',
            alg: 'aes-256-gcm',
        };

        if (conf) {
            this.conf = Object.assign(this.conf, conf);
        }
    }

    start() {
        this._log('starting glounet node ' + this.info.name + ':' + this.info.hash);

        /* start UNIX control socket */
        this.ctrl = net.createServer((c) => {
            this._handle_ctrl_client(c);
        });

        this.ctrl.on('error', (e) => {
            this._log('control socket error: ' + e);
        });

        fs.unlinkSync(this.conf.sockpath);
        this.ctrl.listen(this.conf.sockpath, () => {
            this._log('listening for IPC connections on ' + this.conf.sockpath);
        });

        /* start TCP listener */
        this.tcp = net.createServer((c) => {
            this._handle_tcp_connection(c, true);
        });

        this.tcp.on('error', (e) => {
            this._log('TCP listener error: ' + e);
        });

        this.tcp.listen(this.conf.tcp_port, () => {
            this._log('listening for TCP connections on port ' + this.conf.tcp_port);
        });

        this.udp = dgram.createSocket('udp4');

        this.udp.on('error', (e) => {
            this._log('error in UDP listener: ' + e);
        });

        this.udp.on('listening', () => {
            this.udp.setBroadcast(true);
            const addr = this.udp.address();

            if (this.bci) clearInterval(this.bci);
            this.bci = setInterval(() => {
                this._udp_broadcast();
            }, this.conf.bc_interval);

            this._log('listening for UDP datagrams on port ' + addr.port);
        });

        this.udp.on('message', (msg, rinfo) => {
            this._handle_udp(msg, rinfo);
        });

        this.udp.bind(this.conf.udp_port);
    }

    _udp_broadcast() {
        const dg = {
            info: this.info,
        };

        this.udp.send(JSON.stringify(dg), this.conf.udp_port, '255.255.255.255');
    }

    _handle_udp(msg, rinfo) {
        try {
            const md = JSON.parse(msg);

            if (this.global_clashes(md.info)) return;

            /* node doesn't clash, try and connect to it */
            let sock = net.connect(this.conf.tcp_port, rinfo.address, () => {
                this._handle_tcp_connection(sock, false);
            });
        } catch (e) {
            this._log('error in received broadcast: ' + e);
        }
    }

    _handle_tcp_connection(c, is_server) {
        /* perform half-handshake for now no crypto */
        const iface = rl.createInterface(c, c);
        const ecdh = crypto.createECDH(this.conf.ecdh_curve);
        const ecdh_key = ecdh.generateKeys();

        let bname = Buffer.from(this.info.name, 'utf8');

        let rq = {
            type: 'hello',
            info: this.info,
            key: this.key.get_pubkey(),
            name_sig: this.key.sign(bname.toString('base64')),
            ecdh: ecdh_key.toString('base64'),
            ecdh_sig: this.key.sign(ecdh_key.toString('base64')),
        };

        if (is_server) {
            let sbuf = crypto.randomBytes(this.conf.salt_len);
            rq.salt = sbuf.toString('base64');
            rq.salt_sig = this.key.sign(rq.salt);
        }

        iface.once('line', (rsp) => {
            try {
                const md = JSON.parse(rsp);
                if (md.type != 'hello') throw 'unexpected type';
                if (this.global_clashes(md.info)) throw 'node clashes';

                /* verify matching key hash */
                const hash = crypto.createHash('sha256').update(md.key, 'base64').digest('hex');
                if (hash != md.info.hash) throw 'key hash mismatch';

                /* verify signatures on name, ecdh */
                let bname = Buffer.from(md.info.name, 'utf8');

                if (!this.key.verify(bname.toString('base64'), md.name_sig, md.key)) throw 'name signature';
                if (!this.key.verify(md.ecdh, md.ecdh_sig, md.key)) throw 'ecdh signature';

                if (is_server) {
                    md.salt = rq.salt; /* use the salt we sent */
                } else { 
                    if (!this.key.verify(md.salt, md.salt_sig, md.key)) throw 'salt signature'; /* verify the salt we received */
                }

                /* compute ECDH shared secret */
                const ssec = ecdh.computeSecret(md.ecdh, 'base64', 'base64');

                /* derive session key */
                const skey = crypto.pbkdf2Sync(ssec, md.salt, this.conf.kdf_iterations, this.conf.skey_len, this.conf.kdf_digest);

                /* OK, add the node to the network */
                let rn = new GlouRemoteNode(md.info, (d) => {
                    /* pack up outgoing message */
                    let iv = crypto.randomBytes(this.conf.skey_len);
                    let cip = crypto.createCipheriv(this.conf.alg, skey, iv);
                    const ct = Buffer.concat([cip.update(JSON.stringify(d), 'utf8'), cip.final()]);
                    const tag = cip.getAuthTag();

                    const out = {
                        iv: iv.toString('base64'),
                        tag: tag.toString('base64'),
                        data: ct.toString('base64'),
                    };

                    this._write(c, out);
                }, this, this._log);

                let ind = this.network.length;
                this.network.push(rn);

                this._log('discovered node ' + md.info.name);

                iface.on('line', (d) => {
                    try {
                        /* decrypt incoming message */
                        let msg = JSON.parse(d);
                        let cip = crypto.createDecipheriv(this.conf.alg, skey, Buffer.from(msg.iv, 'base64'));
                        cip.setAuthTag(Buffer.from(msg.tag, 'base64'));
                        let pt = cip.update(msg.data, 'base64', 'utf8') + cip.final('utf8');
                        rn.do_recv(JSON.parse(pt));
                    } catch(e) {}
                });

                c.on('close', () => {
                    this._log('dropping remote node ' + md.info.name + ':' + md.info.hash);
                    this.network.splice(ind, 1);
                });
            } catch (e) {
                this._log('error in handshake: ' + e);
            }
        });

        this._write(c, rq);
    }

    _handle_ctrl_client(c) {
        let iface = rl.createInterface(c, c);

        iface.once('line', (h) => {
            /* handle hello message, make sure service is unique */
            try {
                let hmd = JSON.parse(h);
                if (hmd.name in this.services) throw 'duplicate service name ' + hmd.name;
                this.services[hmd.name] = hmd.init;
                this.service_socks[hmd.name] = c;

                /* service ready, drop to real handlers */
                iface.on('line', (d) => {
                    try {
                        this._handle_ctrl_msg(c, hmd.name, JSON.parse(d));
                    } catch (e) {
                        this._log('error in control message: ' + e + ' : ' + e.stack);
                    }
                });

                c.on('close', () => {
                    this._log('dropping local service ' + hmd.name);
                    delete this.services[hmd.name];
                    delete this.service_socks[hmd.name];
                });

                const rsp = {
                    type: 'hello',
                    info: {
                        name: this.info.name,
                        hash: this.info.hash,
                    },
                };

                this._write(c, rsp);
                this._log('registered local service ' + hmd.name);
            } catch (e) {
                this._log('error initializing control client: ' + e);
                c.destroy();
            }
        });
    }

    _handle_ctrl_msg(c, name, md) {
        this._log(name + ' reading:\n' + JSON.stringify(md, null, 4) + '\n');
        switch (md.type) {
        case 'response':
            if (md.uid in this.resp_handlers) {
                this.resp_handlers[md.uid](md);
                delete this.resp_handlers[md.uid];
            }
            break;
        case 'provide':
            /* update service provider object */
            this.services[name] = md.body;
            this._log('updated ' + name + ' data: ' + JSON.stringify(md.body));
            break;
        case 'remote':
            /* query a node by id (can be us) */
            let rsp = {
                type: 'response',
                status: 'ok',
                uid: md.uid,
            };

            if (this.matches(md.remote)) {
                rsp.list = this._get_local_service_list();
                return this._write(c, rsp);
            }

            return this._find_remote(md.remote, (err, rn) => {
                if (err) {
                    rsp.status = err;
                }

                rsp.list = rn.get_service_list();
                return this._write(c, rsp);
            });
            break;
        case 'service':
            /* get a snapshot of a service from us or any remote */
            {
                let rsp = {
                    type: 'response',
                    status: 'ok',
                    uid: md.uid,
                };

                if (this.matches(md.remote)) {
                    return this._get_local_service(md.name, (err, d) => {
                        if (err) {
                            rsp.status = err;
                        } else {
                            rsp.body = d;
                        }

                        return this._write(c, rsp);
                    });
                } else {
                    return this._get_remote_service(md.remote, md.name, (err, d) => {
                        if (err) {
                            rsp.status = err;
                        } else {
                            rsp.body = d;
                        }

                        return this._write(c, rsp);
                    });
                }
                break;
            }
        case 'call':
            /* call a function from a service */
            {
                let rsp = {
                    type: 'response',
                    status: 'ok',
                    uid: md.uid,
                };

                if (this.matches(md.remote)) {
                    this._call_local_service(md.name, md.fun, md.args, (err, ret) => {
                        if (err) {
                            rsp.status = err;
                        } else {
                            rsp.ret = ret;
                        }

                        this._write(c, rsp);
                    });
                } else {
                    this._call_remote_service(md.remote, md.name, md.fun, md.args, (err, ret) => {
                        if (err) {
                            rsp.status = err;
                        } else {
                            rsp.ret = ret;
                        }

                        this._write(c, rsp);
                    });
                }
            }
        }
    }

    /* call to a local service */
    _call_local_service(name, fun, args, cb) {
        if (name in this.services) {
            const rq = {
                type: 'call',
                fun: fun,
                args: args,
            };

            return this._req(this.service_socks[name], rq, (rsp) => {
                if (rsp.status != 'ok') return cb(rsp.status);
                return cb(null, rsp.ret);
            });
        }
        return cb('err: no service');
    }

    /* pull a service from the local node */
    _get_local_service(name, cb) {
        if (name in this.services) return cb(null, this.services[name]);
        return cb('err: no service');
    }

    /* get list of local providers */
    _get_local_service_list() {
        var out = [];
        for (var k in this.services) {
            if (this.services.hasOwnProperty(k)) {
                out.push(k);
            }
        }
        return out;
    }

    /* pull a service from a remote node */
    _get_remote_service(remote, name, cb) {
        this._find_remote(remote, (err, rn) => {
            if (err) return cb(err);
            return rn.request_service(name, (err, d) => {
                if (err) return cb(err);
                return cb(null, d);
            });
        });
    }

    /* call service from a remote node */
    _call_remote_service(remote, name, fun, args, cb) {
        this._find_remote(remote, (err, rn) => {
            if (err) return cb(err);
            rn.call(name, fun, args, (err, ret) => {
                if (err) return cb(err);
                return cb(null, ret);
            });
        });
    }

    /* ID matching */
    matches(str) {
        if (str[0] == '@') return (this.info.name == str.slice(1));
        return (str == this.info.hash);
    }

    /* check clashes on the whole network */
    global_clashes(info) {
        if (this._clashes(info)) return true;
        for (var i in this.network) {
            if (this.network[i].clashes(info)) return true;
        }
        return false;
    }

    /* info clash detection */ 
    _clashes(info) {
        return ((info.name == this.info.name) || (info.hash == this.info.hash));
    }
    
    /* request helper */
    _req(s, md, cb) {
        md.uid = this._uuid();
        this.resp_handlers[md.uid] = cb;
        this._write(s, md);
    }

    /* search for remote node hash by ID string */
    _find_remote(id, cb) {
        for (var k in this.network) {
            if (this.network[k].matches(id)) return cb(null, this.network[k]);
        }

        return cb('no remote matched ' + id);
    }

    _log(m) {
        console.log('[' + new Date().toLocaleTimeString() + '] glounet: ' + m);
    }

    _uuid() {
        return this.uuid++;
    }

    _write(s, md) {
        s.write(JSON.stringify(md) + '\n');
    }
}

module.exports = GlouNode;
