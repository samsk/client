import config from "./config"
import * as _ from "lodash"

import * as apiLayer from "./api-layer"
import {appStore} from "./store"
import CryptoJS = require("crypto-js")
import {toHex, workerAsync, byteArraysToBlobURL, downloadBlobURL} from "./util"
import {appActions, messageActions} from "./action"

let SocketWorker = require("worker?name=socket.worker.js!./socket-worker")
let socketWorker: Worker = new SocketWorker

export let socket: WebSocket

let connectInterval = undefined

let overrideCounter = 0
function getSyncKey(prepend: string) {
    overrideCounter++
    return prepend + String(overrideCounter)
}

let promiseChain: Promise<any>
let resolves: {[key: string]: any}  = {}

let callbacks: {[key: string]: Function} = {}

export function sendCommandAsync(action: string, ...rest) {
    let key = getSyncKey("override")
    let packet: any = {
        endpoint: action,
        syncKey: key
    }
    let args = []
    let callback = undefined
    for (let arg of rest) {
        if (typeof arg !== "function") {
            args.push(arg)
        }
    }
    args = _.flattenDeep(args)
    if (args.length > 0) {
        packet.args = args
    }
    if (typeof rest[rest.length-1] === "function") {
        callbacks[key] = rest[rest.length-1]
    }
    else {
        callbacks[key] = console.log.bind(console)
    }
    return promiseToSendPacket(packet)
}

export function sendCommand(sock: WebSocket, action, args?) {
    var packet: any = {
        endpoint: action,
        syncKey: getSyncKey("normal")
    }
    if (typeof args !== "undefined") {
        if (args instanceof Array) {
            packet.args = args
        }
        else {
            packet.args = [args]
        }
    }
    return promiseToSendPacket(packet)
}

function promiseToSendPacket(packet) {
    let promise = new Promise((resolve, reject) => {
        resolves[packet.syncKey] = resolve
        setTimeout(() => {
            //still resolve so we don't break the chain
            resolve({endpoint: "error", message: "A request " + packet.endpoint + " timed out!"})
        }, 5000)
    })
    if (promiseChain) {
        promiseChain = promiseChain.then(() => {
            sendPacket(packet)
            return promise
        })
        return promiseChain
    }
    else {
        sendPacket(packet)
        promiseChain = promise
        return promise
    }
}

function sendPacket(packet) {
    socketWorker.postMessage({
        type: "serialize",
        content: {
            appState: appStore.getState(),
            data: packet
        }
    })
}

//jank ass curry
export function sendCommandToDefault(action, args?) {
    return sendCommand(socket, action, args)
}

(window as any).sendCommandToDefault = sendCommandToDefault

export function connect(host: string, port: string) {
    
    try {
        socket = new WebSocket(`ws://${host}:${port}`)
        //socket = new WebSocket(config.server)
        console.log('Socket Status: ' + socket.readyState)
        if (connectInterval === undefined)
        socket.onerror = function(e) {
            if (appStore.getState().connection.host) {
                connectInterval = setInterval(() => {
                    console.log("Not connected... trying to reconnect.")
                    connect(host, port)
                }, 4000)
            }
            else {
                messageActions.message({style: "danger", text: "Failed to connect. Host invalid."})
            }
        }
        socket.onopen = function() {
            console.log('Socket Status: ' + socket.readyState + ' (open)')
            if (connectInterval !== undefined && socket.readyState === 1) {
                
                clearInterval(connectInterval)
            }
            if (socket.readyState === 1) {
                appActions.setHost({host, port})
            }
        }
        
        socket.onmessage = function(e) {
            
            if (typeof e.data === "string") {
                workerAsync(socketWorker, "deserialize", {
                    appState: appStore.getState(),
                    data: e.data
                },
                (message: ApiMessage) => {
                    let {syncKey, results, endpoint} = message
                    if (endpoint != "getcameraframe") {
                        console.log(endpoint)
                    }
                    if (!syncKey || (syncKey as string).indexOf("override") == -1) {
                        defaultHandleMessage(message)
                    }
                    else {
                        if (callbacks[syncKey] && 
                            typeof callbacks[syncKey] == "function") {
                            callbacks[syncKey](results)
                            callbacks[syncKey] = undefined
                        }
                    }
                    if (syncKey && resolves[syncKey]) {
                        resolves[syncKey](results)
                        resolves[syncKey] = null
                    }
                })
            }
            else if (e.data instanceof ArrayBuffer) {
                console.log("ArrayBuffer get (for some reason): " + e.data)
            }
            else if (e.data instanceof Blob) {
                console.log("Blob get " + e.data)
                let reader = new FileReader()
                reader.readAsDataURL(e.data)
                reader.onloadend = () => {
                    workerAsync(socketWorker, "decrypt", {
                        appState: appStore.getState(),
                        data: reader.result
                    }, (data: Uint8Array) => {
                        //console.log(data)
                        downloadBlobURL(byteArraysToBlobURL([data]))
                    })
                    //console.log(reader.result)
                }
            }
            
            socket.onclose = function(e) {
                if (e.code !== 1000) {
                    console.log("Socket... died? Trying to reconnect in a sec...")
                    apiLayer.disconnectedFromUlterius()
                    connectInterval = setInterval(() => {
                        console.log("Disconnected. Trying to reconnect now...")
                        connect(appStore.getState().connection.host, appStore.getState().connection.port)
                    }, 4000)
                }
            }
        }

    }
    catch (err) {
        console.log(err)
    }
    finally {
        return socket
    }
}

function defaultHandleMessage(message: ApiMessage) {
    let caught = false
    for (let endpoint of Object.keys(apiLayer)) {
        if (message.endpoint &&
            message.endpoint.toLowerCase() == endpoint.toLowerCase() &&
            typeof apiLayer[endpoint] == "function") {

            apiLayer[endpoint](message.results)
            caught = true
        }
    }
    if (message.endpoint && apiLayer.listeners[message.endpoint.toLowerCase()]) {
        for (let fn of apiLayer.listeners[message.endpoint.toLowerCase()]) {
            fn(message.results)
        }
    }
    if (!caught) {
        console.log("Uncaught message: " + message.endpoint)
        console.log(message)
    }
}

export function disconnect() {
    socket.close()
    appActions.setHost({host: "", port: ""})
}

socketWorker.addEventListener("message", ({data}) => {
    let wmessage = data as WorkerMessage<any>
    
    if (wmessage.type == "deserialize") {
        /*
        //let dataObject = decrypt(e.data)
        let dataObject = wmessage.content

        let message = (dataObject as ApiMessage)
        if (message.endpoint != "getcameraframe") {
            console.log(message.endpoint)
        }
        if (!message.syncKey || (message.syncKey as string).indexOf("override") == -1) {
            defaultHandleMessage(message)
        }
        else {
            if (callbacks[message.syncKey] && typeof callbacks[message.syncKey] == "function") {
                callbacks[message.syncKey](message.results)
                callbacks[message.syncKey] = undefined
            }
        }
        */
    }
    else if (wmessage.type == "serialize") {
        try {
            socket.send(wmessage.content)
        }
        catch (e) {
            console.log(e)
        }
    }
})