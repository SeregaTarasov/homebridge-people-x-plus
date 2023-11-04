var ping = require('ping');
var arp = require('arp-a-x');
var moment = require('moment');
var request = require("request");
var http = require('http');
var url = require('url');
var DEFAULT_REQUEST_TIMEOUT = 10000;
var FakeGatoHistoryService;
const EPOCH_OFFSET = 978307200;

var Service, Characteristic, HomebridgeAPI;
module.exports = function(homebridge) {
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;
    HomebridgeAPI = homebridge;
    FakeGatoHistoryService = require('fakegato-history')(homebridge);

    homebridge.registerPlatform("homebridge-people-x-plus", "PeopleXPlus", PeoplePlatform);
    homebridge.registerAccessory("homebridge-people-x-plus", "PeopleAccessory", PeopleAccessory);
    homebridge.registerAccessory("homebridge-people-x-plus", "PeopleAllAccessory", PeopleAllAccessory);
}

// #######################
// PeoplePlatform
// #######################

function PeoplePlatform(log, config){
    this.log = log;
    this.threshold = config['threshold'] || 15;
    this.anyoneSensorName = ((typeof(config['anyoneSensorName']) != "undefined" && config['anyoneSensorName'] !== null)?config['anyoneSensorName']:'Anyone');
    this.nooneSensorName = ((typeof(config['nooneSensorName']) != "undefined" && config['nooneSensorName'] !== null)?config['nooneSensorName']:'No One');
    this.guestSensorName = ((typeof(config['guestSensorName']) != "undefined" && config['guestSensorName'] !== null)?config['guestSensorName']:'Guests');
    this.anyoneSensor = ((typeof(config['anyoneSensor']) != "undefined" && config['anyoneSensor'] !== null)?config['anyoneSensor']:true);
    this.nooneSensor = ((typeof(config['nooneSensor']) != "undefined" && config['nooneSensor'] !== null)?config['nooneSensor']:true);
    this.guestSensor = ((typeof(config['guestSensor']) != "undefined" && config['guestSensor'] !== null)?config['guestSensor']:true);
    this.webhookEnabled = ((typeof(config['webhookEnabled']) != "undefined" && config['webhookEnabled'] !== null)?config['webhookEnabled']:true);
    this.webhookPort = config["webhookPort"] || 51828;
    this.cacheDirectory = config["cacheDirectory"] || HomebridgeAPI.user.persistPath();
    this.checkInterval = config["checkInterval"] || 10000;
    this.ignoreReEnterExitSeconds = config["ignoreReEnterExitSeconds"] || 0;
    this.anyoneSensorOnURL = config["anyoneSensor_on_url"] || "";
    this.anyoneSensorOnMethod = config["anyoneSensor_on_method"] || "GET";
    this.anyoneSensorOnBody = config["anyoneSensor_on_body"] || "";
    this.anyoneSensorOnForm = config["anyoneSensor_on_form"] || "";
    this.anyoneSensorOnHeaders = config["anyoneSensor_on_headers"] || "{}";
    this.anyoneSensorOffURL = config["anyoneSensor_off_url"] || "";
    this.anyoneSensorOffMethod = config["anyoneSensor_off_method"] || "GET";
    this.anyoneSensorOffBody = config["anyoneSensor_off_body"] || "";
    this.anyoneSensorOffForm = config["anyoneSensor_off_form"] || "";
    this.anyoneSensorOffHeaders = config["anyoneSensor_off_headers"] || "{}";
    this.nooneSensorOnURL = config["nooneSensor_on_url"] || "";
    this.nooneSensorOnMethod = config["nooneSensor_on_method"] || "GET";
    this.nooneSensorOnBody = config["nooneSensor_on_body"] || "";
    this.nooneSensorOnForm = config["nooneSensor_on_form"] || "";
    this.nooneSensorOnHeaders = config["nooneSensor_on_headers"] || "{}";
    this.nooneSensorOffURL = config["nooneSensor_off_url"] || "";
    this.nooneSensorOffMethod = config["nooneSensor_off_method"] || "GET";
    this.nooneSensorOffBody = config["nooneSensor_off_body"] || "";
    this.nooneSensorOffForm = config["nooneSensor_off_form"] || "";
    this.nooneSensorOffHeaders = config["nooneSensor_off_headers"] || "{}";
    this.guestSensorOnURL = config["guestSensor_on_url"] || "";
    this.guestSensorOnMethod = config["guestSensor_on_method"] || "GET";
    this.guestSensorOnBody = config["guestSensor_on_body"] || "";
    this.guestSensorOnForm = config["guestSensor_on_form"] || "";
    this.guestSensorOnHeaders = config["guestSensor_on_headers"] || "{}";
    this.guestSensorOffURL = config["guestSensor_off_url"] || "";
    this.guestSensorOffMethod = config["guestSensor_off_method"] || "GET";
    this.guestSensorOffBody = config["guestSensor_off_body"] || "";
    this.guestSensorOffForm = config["guestSensor_off_form"] || "";
    this.guestSensorOffHeaders = config["guestSensor_off_headers"] || "{}";
    this.people = config['people'];
    this.storage = require('node-persist');
    this.storage.initSync({dir:this.cacheDirectory, forgiveParseErrors: true});
    this.webhookQueue = [];
}

PeoplePlatform.prototype = {

    accessories: function(callback) {
        this.accessories = [];
        this.peopleAccessories = [];
        for(var i = 0; i < this.people.length; i++){
            var peopleAccessory = new PeopleAccessory(this.log, this.people[i], this);
            this.accessories.push(peopleAccessory);
            this.peopleAccessories.push(peopleAccessory);
        }
        if(this.anyoneSensor) {
            this.peopleAnyOneAccessory = new PeopleAllAccessory(this.log, this.anyoneSensorName, this);
            this.accessories.push(this.peopleAnyOneAccessory);
        }
        if(this.nooneSensor) {
            this.peopleNoOneAccessory = new PeopleAllAccessory(this.log, this.nooneSensorName, this);
            this.accessories.push(this.peopleNoOneAccessory);
        }
        if(this.guestSensor) {
            this.peopleGuestAccessory = new PeopleAllAccessory(this.log, this.guestSensorName, this);
            this.accessories.push(this.peopleGuestAccessory);
        }
        callback(this.accessories);

        if(this.webhookEnabled) {
            this.startServer();
        }
    },

    startServer: function() {
        //
        // HTTP webserver code influenced by benzman81's great
        // homebridge-http-webhooks homebridge plugin.
        // https://github.com/benzman81/homebridge-http-webhooks
        //

        // Start the HTTP webserver
        http.createServer((function(request, response) {
            var theUrl = request.url;
            var theUrlParts = url.parse(theUrl, true);
            var theUrlParams = theUrlParts.query;
            var body = [];
            request.on('error', (function(err) {
                this.log("WebHook error: %s.", err);
            }).bind(this)).on('data', function(chunk) {
                body.push(chunk);
            }).on('end', (function() {
                body = Buffer.concat(body).toString();

                response.on('error', function(err) {
                    this.log("WebHook error: %s.", err);
                });

                response.statusCode = 200;
                response.setHeader('Content-Type', 'application/json');

                if(!theUrlParams.sensor || !theUrlParams.state) {
                    response.statusCode = 404;
                    response.setHeader("Content-Type", "text/plain");
                    var errorText = "WebHook error: No sensor or state specified in request.";
                    this.log(errorText);
                    response.write(errorText);
                    response.end();
                }
                else {
                    var sensor = theUrlParams.sensor.toLowerCase();
                    var newState = (theUrlParams.state == "true");
                    this.log('Received hook for ' + sensor + ' -> ' + newState);
                    var responseBody = {
                        success: true
                    };
                    for(var i = 0; i < this.peopleAccessories.length; i++){
                        var peopleAccessory = this.peopleAccessories[i];
                        var target = peopleAccessory.target
                        if(peopleAccessory.name.toLowerCase() === sensor) {
                            this.clearWebhookQueueForTarget(target);
                            this.webhookQueue.push({"target": target, "newState": newState, "timeoutvar": setTimeout((function(){
                                    this.runWebhookFromQueueForTarget(target);
                                }).bind(this),  peopleAccessory.ignoreReEnterExitSeconds * 1000)});
                            break;
                        }
                    }
                    response.write(JSON.stringify(responseBody));
                    response.end();
                }
            }).bind(this));
        }).bind(this)).listen(this.webhookPort);
        this.log("WebHook: Started server on port '%s'.", this.webhookPort);
    },

    clearWebhookQueueForTarget: function(target) {
        for (var i = 0; i < this.webhookQueue.length; i++) {
            var webhookQueueEntry = this.webhookQueue[i];
            if(webhookQueueEntry.target == target) {
                clearTimeout(webhookQueueEntry.timeoutvar);
                this.webhookQueue.splice(i, 1);
                break;
            }
        }
    },

    runWebhookFromQueueForTarget: function(target) {
        for (var i = 0; i < this.webhookQueue.length; i++) {
            var webhookQueueEntry = this.webhookQueue[i];
            if(webhookQueueEntry.target == target) {
                this.log('Running hook for ' + target + ' -> ' + webhookQueueEntry.newState);
                this.webhookQueue.splice(i, 1);
                this.storage.setItemSync('lastWebhook_' + target, Date.now());
                this.getPeopleAccessoryForTarget(target).setNewState(webhookQueueEntry.newState);
                break;
            }
        }
    },

    getPeopleAccessoryForTarget: function(target) {
        for(var i = 0; i < this.peopleAccessories.length; i++){
            var peopleAccessory = this.peopleAccessories[i];
            if(peopleAccessory.target === target) {
                return peopleAccessory;
            }
        }
        return null;
    }
}

// #######################
// PeopleAccessory
// #######################

function PeopleAccessory(log, config, platform) {
    this.log = log;
    this.name = config['name'];
    this.target = config['target'];
    this.macAddress = config['macAddress'];
    this.platform = platform;
    this.threshold = config['threshold'] || this.platform.threshold;
    this.checkInterval = config['checkInterval'] || this.platform.checkInterval;
    this.useArp = ((typeof(config['useArp']) != "undefined" && config['useArp'] !== null)?config['useArp']:false);
    this.isGuest = ((typeof(config['isGuest']) != "undefined" && config['isGuest'] !== null)?config['isGuest']:false);
    this.statusOnly = ((typeof(config['statusOnly']) != "undefined" && config['statusOnly'] !== null)?config['statusOnly']:false);
    this.ignoreReEnterExitSeconds = config['ignoreReEnterExitSeconds'] || this.platform.ignoreReEnterExitSeconds;
    this.onURL = config["on_url"] || "";
    this.onMethod = config["on_method"] || "GET";
    this.onBody = config["on_body"] || "";
    this.onForm = config["on_form"] || "";
    this.onHeaders = config["on_headers"] || "{}";
    this.offURL = config["off_url"] || "";
    this.offMethod = config["off_method"] || "GET";
    this.offBody = config["off_body"] || "";
    this.offForm = config["off_form"] || "";
    this.offHeaders = config["off_headers"] || "{}";
    this.stateCache = false;

    class LastActivationCharacteristic extends Characteristic {
        constructor(accessory) {
            super('LastActivation', 'E863F11A-079E-48FF-8F27-9C2605A29F52');
            this.setProps({
                format: Characteristic.Formats.UINT32,
                unit: Characteristic.Units.SECONDS,
                perms: [
                    Characteristic.Perms.READ,
                    Characteristic.Perms.NOTIFY
                ]
            });
        }
    }

    class SensitivityCharacteristic extends Characteristic {
        constructor(accessory) {
            super('Sensitivity', 'E863F120-079E-48FF-8F27-9C2605A29F52');
            this.setProps({
                format: Characteristic.Formats.UINT8,
                minValue: 0,
                maxValue: 7,
                validValues: [0, 4, 7],
                perms: [
                    Characteristic.Perms.READ,
                    Characteristic.Perms.NOTIFY,
                    Characteristic.Perms.WRITE
                ]
            });
        }
    }

    class DurationCharacteristic extends Characteristic {
        constructor(accessory) {
            super('Duration', 'E863F12D-079E-48FF-8F27-9C2605A29F52');
            this.setProps({
                format: Characteristic.Formats.UINT16,
                unit: Characteristic.Units.SECONDS,
                minValue: 5,
                maxValue: 15 * 3600,
                validValues: [
                    5, 10, 20, 30,
                    1 * 60, 2 * 60, 3 * 60, 5 * 60, 10 * 60, 20 * 60, 30 * 60,
                    1 * 3600, 2 * 3600, 3 * 3600, 5 * 3600, 10 * 3600, 12 * 3600, 15 * 3600
                ],
                perms: [
                    Characteristic.Perms.READ,
                    Characteristic.Perms.NOTIFY,
                    Characteristic.Perms.WRITE
                ]
            });
        }
    }

    this.service = new Service.OccupancySensor(this.name);
    this.service
        .getCharacteristic(Characteristic.OccupancyDetected)
        .on('get', this.getState.bind(this));

    this.service.addCharacteristic(LastActivationCharacteristic);
    this.service
        .getCharacteristic(LastActivationCharacteristic)
        .on('get', this.getLastActivation.bind(this));


    this.service.addCharacteristic(SensitivityCharacteristic);
    this.service
        .getCharacteristic(SensitivityCharacteristic)
        .on('get', function(callback){
            callback(null, 4);
        }.bind(this));

    this.service.addCharacteristic(DurationCharacteristic);
    this.service
        .getCharacteristic(DurationCharacteristic)
        .on('get', function(callback){
            callback(null, 5);
        }.bind(this));

    this.accessoryService = new Service.AccessoryInformation;
    this.accessoryService
        .setCharacteristic(Characteristic.Name, this.name)
        .setCharacteristic(Characteristic.SerialNumber, "hps-"+this.name.toLowerCase())
        .setCharacteristic(Characteristic.Manufacturer, "Elgato");

    this.historyService = new FakeGatoHistoryService("motion", {
            displayName: this.name,
            log: this.log
        },
        {
            storage: 'fs',
            disableTimer: true
        });

    this.initStateCache();

    if((this.checkInterval > -1) && !(this.useArp)) {
        this.ping();
    }

    if((this.checkInterval > -1) && (this.useArp)) {
        this.arp();
    }
}

PeopleAccessory.encodeState = function(state) {
    if (state)
        return Characteristic.OccupancyDetected.OCCUPANCY_DETECTED;
    else
        return Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED;
}

PeopleAccessory.prototype.getState = function(callback) {
    callback(null, PeopleAccessory.encodeState(this.stateCache));
}

PeopleAccessory.prototype.getLastActivation = function(callback) {
    var lastSeenUnix = this.platform.storage.getItemSync('lastSuccessfulPing_' + this.target);
    if (lastSeenUnix) {
        var lastSeenMoment = moment(lastSeenUnix).unix();
        callback(null, lastSeenMoment - this.historyService.getInitialTime());
    }
}

PeopleAccessory.prototype.identify = function(callback) {
    this.log("Identify: "+this.name);
    callback();
}

PeopleAccessory.prototype.initStateCache = function() {
    var isActive = this.isActive();
    this.stateCache = isActive;
}

PeopleAccessory.prototype.isActive = function() {
    var lastSeenUnix = this.platform.storage.getItemSync('lastSuccessfulPing_' + this.target);
    if (lastSeenUnix) {
        var lastSeenMoment = moment(lastSeenUnix);
        var activeThreshold = moment().subtract(this.threshold, 'm');
        return lastSeenMoment.isAfter(activeThreshold);
    }
    return false;
}

PeopleAccessory.prototype.ping = function() {
    if(this.webhookIsOutdated()) {
        ping.sys.probe(this.target, function(state){
            if(this.webhookIsOutdated()) {
                if (state) {
                    this.platform.storage.setItemSync('lastSuccessfulPing_' + this.target, Date.now());
                }
                if(this.successfulPingOccurredAfterWebhook()) {
                    var newState = this.isActive();
                    this.setNewState(newState);
                }
            }
            setTimeout(PeopleAccessory.prototype.ping.bind(this), this.checkInterval);
        }.bind(this));
    }
    else {
        setTimeout(PeopleAccessory.prototype.ping.bind(this), this.checkInterval);
    }
}

PeopleAccessory.prototype.arp = function() {
    if(this.webhookIsOutdated()) {
        ping.sys.probe(this.target, function(state){
            arp.table(function(error, entry) {
                if(this.webhookIsOutdated()) {
                    if(error) {
                        this.log('ARP Error: %s', error.message);
                    } else {
                        if (entry) {
                            if(entry.mac == this.macAddress.toLowerCase() && entry.flag == "0x2") {
                                this.platform.storage.setItemSync('lastSuccessfulPing_' + this.target, Date.now());
                            }
                        }
                    }             
                }
            }.bind(this));
            if(this.successfulPingOccurredAfterWebhook()) {
                var newState = this.isActive();
                this.setNewState(newState);
            }
            setTimeout(PeopleAccessory.prototype.arp.bind(this), this.checkInterval);
        }.bind(this));
    } else {
        setTimeout(PeopleAccessory.prototype.arp.bind(this), this.checkInterval);
    }
}

PeopleAccessory.prototype.webhookIsOutdated = function() {
    var lastWebhookUnix = this.platform.storage.getItemSync('lastWebhook_' + this.target);
    if (lastWebhookUnix) {
        var lastWebhookMoment = moment(lastWebhookUnix);
        var activeThreshold = moment().subtract(this.threshold, 'm');
        return lastWebhookMoment.isBefore(activeThreshold);
    }
    return true;
}

PeopleAccessory.prototype.successfulPingOccurredAfterWebhook = function() {
    var lastSuccessfulPing = this.platform.storage.getItemSync('lastSuccessfulPing_' + this.target);
    if(!lastSuccessfulPing) {
        return false;
    }
    var lastWebhook = this.platform.storage.getItemSync('lastWebhook_' + this.target);
    if(!lastWebhook) {
        return true;
    }
    var lastSuccessfulPingMoment = moment(lastSuccessfulPing);
    var lastWebhookMoment = moment(lastWebhook);
    return lastSuccessfulPingMoment.isAfter(lastWebhookMoment);
}

PeopleAccessory.prototype.setNewState = function(newState) {
    var oldState = this.stateCache;
    if (oldState != newState) {
        this.stateCache = newState;
        this.service.getCharacteristic(Characteristic.OccupancyDetected).updateValue(PeopleAccessory.encodeState(newState));

        if(this.platform.peopleAnyOneAccessory) {
            this.platform.peopleAnyOneAccessory.refreshState();
        }

        if(this.platform.peopleNoOneAccessory) {
            this.platform.peopleNoOneAccessory.refreshState();
        }

        if(this.platform.peopleGuestAccessory) {
            this.platform.peopleGuestAccessory.refreshState();
        }

        var lastSuccessfulPingMoment = "none";
        var lastWebhookMoment = "none";
        var lastSuccessfulPing = this.platform.storage.getItemSync('lastSuccessfulPing_' + this.target);
        if(lastSuccessfulPing) {
            lastSuccessfulPingMoment = moment(lastSuccessfulPing).format();
        }
        var lastWebhook = this.platform.storage.getItemSync('lastWebhook_' + this.target);
        if(lastWebhook) {
            lastWebhookMoment = moment(lastWebhook).format();
        }

        this.historyService.addEntry(
            {
                time: moment().unix(),
                status: (newState) ? 1 : 0
            });
        this.log('Изменение статуса %s (%s) на %s. Последний успешный пинг %s .', this.target, this.name, newState, lastSuccessfulPingMoment);
        this.callHttpWebhook();
    }
}

PeopleAccessory.prototype.callHttpWebhook = function() {
    var urlToCall = this.onURL;
    var urlMethod = this.onMethod;
    var urlBody = this.onBody;
    var urlForm = this.onForm;
    var urlHeaders = this.onHeaders;
    
    if (!this.stateCache) {
        urlToCall = this.offURL;
        urlMethod = this.offMethod;
        urlBody = this.offBody;
        urlForm = this.offForm;
        urlHeaders = this.offHeaders;
    }
    if (urlToCall !== "") {
        var theRequest = {
            method : urlMethod,
            url : urlToCall,
            timeout : DEFAULT_REQUEST_TIMEOUT,
            headers: JSON.parse(urlHeaders)
        };
        if (urlMethod === "POST" || urlMethod === "PUT") {
            if (urlForm) {
                this.log("Adding Form " + urlForm);
                theRequest.form = JSON.parse(urlForm);
            }
            else if (urlBody) {
                this.log("Adding Body " + urlBody);
                theRequest.body = urlBody;
            }
        }
        request(theRequest, (function(err, response, body) {
            var statusCode = response && response.statusCode ? response.statusCode : -1;
            this.log("Request to '%s' finished with status code '%s' and body '%s'.", urlToCall, statusCode, body, err);
        }).bind(this));
    }
}

PeopleAccessory.prototype.getServices = function() {

    var servicesList = [this.service];

    if(this.historyService) {
        servicesList.push(this.historyService)
    }
    if(this.accessoryService) {
        servicesList.push(this.accessoryService)
    }

    return servicesList;

}

// #######################
// PeopleAllAccessory
// #######################

function PeopleAllAccessory(log, name, platform) {
    this.log = log;
    this.name = name;
    this.platform = platform;

    this.service = new Service.OccupancySensor(this.name);
    this.service
        .getCharacteristic(Characteristic.OccupancyDetected)
        .on('get', this.getState.bind(this));

    this.accessoryService = new Service.AccessoryInformation;
    if(this.name === this.platform.nooneSensorName) {
        this.serialNumber = "hps-noone";
    }
    else if(this.name === this.platform.guestSensorName) {
        this.serialNumber = "hps-guest";
    }
    else {
        this.serialNumber = "hps-all";
    }
    this.stateCache = false;
    
    this.accessoryService
        .setCharacteristic(Characteristic.Name, this.name)
        .setCharacteristic(Characteristic.SerialNumber, this.serialNumber)
        .setCharacteristic(Characteristic.Manufacturer, "Elgato");
}

PeopleAllAccessory.prototype.getState = function(callback) {
    callback(null, PeopleAccessory.encodeState(this.getStateFromCache()));
}

PeopleAllAccessory.prototype.identify = function(callback) {
    this.log("Identify: "+this.name);
    callback();
}

PeopleAllAccessory.prototype.getStateFromCache = function() {
    var isAnyoneActive = this.getAnyoneStateFromCache();
    var isGuestActive = this.getGuestStateFromCache();
    
    if(this.name === this.platform.nooneSensorName) {
        return !isAnyoneActive && !isGuestActive;
    }
    else if(this.name === this.platform.guestSensorName) {
        return !isAnyoneActive && isGuestActive;
    }
    else {
        return isAnyoneActive || isGuestActive;
    }
}

PeopleAllAccessory.prototype.getAnyoneStateFromCache = function() {
    for(var i = 0; i < this.platform.peopleAccessories.length; i++){
        var peopleAccessory = this.platform.peopleAccessories[i];
        var isActive = peopleAccessory.stateCache;
        var isGuest = peopleAccessory.isGuest;
        var statusOnly = peopleAccessory.statusOnly;
        if(isActive && !statusOnly && !isGuest) {
            return true;
        }
    }
    return false;
}

PeopleAllAccessory.prototype.getGuestStateFromCache = function() {
    for(var i = 0; i < this.platform.peopleAccessories.length; i++){
        var peopleAccessory = this.platform.peopleAccessories[i];
        var isActive = peopleAccessory.stateCache;
        var isGuest = peopleAccessory.isGuest;
        var statusOnly = peopleAccessory.statusOnly;
        if(isActive && !statusOnly && isGuest) {
            return true;
        }
    }
    return false;
}

PeopleAllAccessory.prototype.refreshState = function() {
    var oldState = this.stateCache;
    var newState = this.getStateFromCache();

    this.service.getCharacteristic(Characteristic.OccupancyDetected).updateValue(PeopleAccessory.encodeState(newState));
    
    if (oldState != newState) {
        this.stateCache = newState;
        
        this.log("Changed sensor '%s' state to %s.", this.name, newState);
        this.callHttpWebhook();
    }
}

PeopleAllAccessory.prototype.callHttpWebhook = function() {
    var urlToCall;
    var urlMethod;
    var urlBody;
    var urlForm;
    var urlHeaders;

    if(this.name === this.platform.nooneSensorName) {
        urlToCall = this.platform.nooneSensorOnURL;
        urlMethod = this.platform.nooneSensorOnMethod;
        urlBody = this.platform.nooneSensorOnBody;
        urlForm = this.platform.nooneSensorOnForm;
        urlHeaders = this.platform.nooneSensorOnHeaders;
        
        if (!this.stateCache) {
            urlToCall = this.platform.nooneSensorOffURL;
            urlMethod = this.platform.nooneSensorOffMethod;
            urlBody = this.platform.nooneSensorOffBody;
            urlForm = this.platform.nooneSensorOffForm;
            urlHeaders = this.platform.nooneSensorOffHeaders;
        }
    }
    else if(this.name === this.platform.guestSensorName) {
        urlToCall = this.platform.guestSensorOnURL;
        urlMethod = this.platform.guestSensorOnMethod;
        urlBody = this.platform.guestSensorOnBody;
        urlForm = this.platform.guestSensorOnForm;
        urlHeaders = this.platform.guestSensorOnHeaders;
        
        if (!this.stateCache) {
            urlToCall = this.platform.guestSensorOffURL;
            urlMethod = this.platform.guestSensorOffMethod;
            urlBody = this.platform.guestSensorOffBody;
            urlForm = this.platform.guestSensorOffForm;
            urlHeaders = this.platform.guestSensorOffHeaders;
        }
    }
    else {
        urlToCall = this.platform.anyoneSensorOnURL;
        urlMethod = this.platform.anyoneSensorOnMethod;
        urlBody = this.platform.anyoneSensorOnBody;
        urlForm = this.platform.anyoneSensorOnForm;
        urlHeaders = this.platform.anyoneSensorOnHeaders;
        
        if (!this.stateCache) {
            urlToCall = this.platform.anyoneSensorOffURL;
            urlMethod = this.platform.anyoneSensorOffMethod;
            urlBody = this.platform.anyoneSensorOffBody;
            urlForm = this.platform.anyoneSensorOffForm;
            urlHeaders = this.platform.anyoneSensorOffHeaders;
        }
    }
    
    if (urlToCall !== "") {
        var theRequest = {
            method : urlMethod,
            url : urlToCall,
            timeout : DEFAULT_REQUEST_TIMEOUT,
            headers: JSON.parse(urlHeaders)
        };
        if (urlMethod === "POST" || urlMethod === "PUT") {
            if (urlForm) {
                this.log("Adding Form " + urlForm);
                theRequest.form = JSON.parse(urlForm);
            }
            else if (urlBody) {
                this.log("Adding Body " + urlBody);
                theRequest.body = urlBody;
            }
        }
        request(theRequest, (function(err, response, body) {
            var statusCode = response && response.statusCode ? response.statusCode : -1;
            this.log("Request to '%s' finished with status code '%s' and body '%s'.", urlToCall, statusCode, body, err);
        }).bind(this));
    }
}

PeopleAllAccessory.prototype.getServices = function() {
    return [this.service, this.accessoryService];
}
