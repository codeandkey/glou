## glou
interactive javascript over a peer-to-peer network
### purpose
glou is a peer-to-peer system which makes it easy to link services and data transfer over a network.

Every glou node can expose services which each provide an interactive javascript object.

Other nodes can query the object and then interact with the service as if it were running in the same environment.
### example
Provider service:

    const glou = require('glou')('ProviderServiceName');

    /* this service provides some variables with data and a function which echoes its input */
    /* the service is provided under the node running on this computer under IPC */

    glou.on('start', () => {
        const service = {
            a: "information here",
            b: "more information here",
            echo: (m) => { return m; },
        };

        glou.provide(service);
    });

    glou.start();

User service:

    const glou = require('glou')('ReaderServiceName');

    glou.on('start', () => {
        /* get a reference to a remote node (the one running ProviderServiceName) */
        glou.node('@TestNodeName', (err, node) => {
            /* get a reference to our service within that node */
            node.service('ProviderServiceName', (err, svc) => {
                /* at this point `svc` is a network wrapper to the `service` object provided by the other node! */
                /* we can now interact with it as if it were a local object. */
                /* because we can't call it synchronously we have to prepend a callback to the arguments. */

                console.log(svc.a); /* "information here" */
                console.log(svc.b); /* "more information here" */

                svc.echo((ret) => {
                    console.log(ret); /* "Hello world!" */
                }, 'Hello world!);
            });
        });
    });

    glou.start();
### architecture
glou is split into a low-level networking layer and a higher-level javascript interface.

The low-level layer must be running on the local system for the javascript interface to function.

All communication over TCP is secured with authenticated AES-256 encryption (GCM mode).

Key echange is performed with ECDH over prime256v1 and pbkdf2 for key derivation. RSA keys are used to identify and verify nodes.
