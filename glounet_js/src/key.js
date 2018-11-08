/*
 * key.rs
 *
 * local key management
 */

const fs = require('fs');
const NodeRSA = require('node-rsa');
const crypto = require('crypto');

const prefix = process.env.HOME + '/.glou/';

class Key {
    constructor(conf) {
        this.hash = "ERROR";

        this.conf = {
            keyfile: prefix + 'key.pem',
        };

        if (conf) {
            this.conf = Object.assign(this.conf, conf);
        } else {
            if (!fs.existsSync(prefix)) {
                fs.mkdirSync(prefix);
            }
        }

        /* try and load up keyfile from the path */
        try {
            this.key = new NodeRSA(fs.readFileSync(this.conf.keyfile));
        } catch(e) {
            if (fs.existsSync(this.conf.keyfile)) {
                throw 'Invalid key data. Not going to overwrite this.';
            }

            console.log("key: couldn't read key from " + this.conf.keyfile + ", generating a new one");

            this.key = new NodeRSA();
            this.key.generateKeyPair();

            try {
                fs.writeFileSync(this.conf.keyfile, this.key.exportKey('pkcs8-private-pem'));
                console.log('key: wrote new keypair to ' + this.conf.keyfile);
            } catch(e) {
                console.log('key: failed to write keyfile ' + this.conf.keyfile);
            }
        }

        const h = crypto.createHash('sha256');
        this.hash = h.update(this.get_pubkey(), 'base64').digest('hex');
    }

    get_pubkey() {
        return this.key.exportKey('pkcs8-public-der').toString('base64');
    }

    sign(d) {
        return this.key.sign(d, 'base64', 'base64');
    }

    verify(d, sig, pkey) {
        try {
            const k = new NodeRSA(Buffer.from(pkey, 'base64'), 'pkcs8-public-der')
            return k.verify(d, sig, 'base64', 'base64');
        } catch(e) {
            return false;
        }
    }
}

module.exports = Key;
