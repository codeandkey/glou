### glounet
reference implementation of a glou network node
#### architecture
glou is very suited to work with JSON data so a node server works together very well

# ----- #
node
    send service list to other nodes
    send requested services to other nodes (req/resp)
    receive service set operation from other nodes (req/resp)
    receive service call operation from other nodes (req/resp)
    retrieve service lists from other nodes
    send service set operation to other nodes (req/resp)
    send servive call operation to other nodes (req/resp)

# ----- network-level message types ----- #

hello:                      |  initial message from the client to the server
    name: NAME              |  claimed node name
    key: PKEY               |  base64 ECDSA/RSA public key
    (crypto consts)         |  anything else we need for the crypto handshake

services:                   |  description of this node's provided services
    names: [                |  array of service names
        "svc1",             |
        "svc2",             |
        "..."]              |                          

call:                       | calling a remote service function
    service: "svc1"         | target service name
    uid: 71646              | request UID
    fid: "bd82ndw"          | unique function id given in the service object
    args: [...]             | arguments to pass to the function

return:                     | response to 'call'
    uid: UUID               | call uid
    (val: RETVAL)           | optional return value

service:                    | description of a specific service, probably enclosed in `response`
    name: "svc1",           | service name
    obj: {                  | service body
        x: 1,               | current data given to the service
        y: 1,               |   
        echo: "bd82ndw",    | service functions are replaced with unique IDs which refer to them
    }

# ----- control-level message types ----- #

provides:                   | provide a service through this connection, only one allowed
    name: "svc1",           | service name
    body: {...}             | service body, functions should be replaced with ids

incall:                     | another node calling a local function
    fn: "bd82ndw",          | function name
    uid: UUID               | call id
    args: [...]             | arguments

outreturn:                  | return a value to an external caller
    uid: UUID
    (val: {...})

outcall:                    | call a function from another node
    name: NODENAME
    service: SVCNAME
    fn: FNID
    uid: UUID
    args: [...]

inreturn:                   | value return from an outcall
    name: 

each UNIX socket connection corresponds to a glou service.
So can't the network layer be simpler? calls can basically be directly relayed
