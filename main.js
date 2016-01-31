var mqtt = require('mqtt');
var util = require('util');
var events = require('events');

var CONTROL_REGEX = /skynet\/control\/([a-z]+)\/([0-9]+)$/;
var SENSOR_REGEX = /skynet\/robot\/sensors\/([a-z]+)\/([0-9]+)$/;
var STATUS_REGEX = /skynet\/robot\/status\/([a-z0-9]+)$/;

function SkynetEndpoint(url, clientId, debug) {
	// Make this class an event emitter
	events.EventEmitter.call(this);

	if (clientId === undefined) {
		clientId = 'skynet_ep_' + Math.random().toString(16).substr(2,5);
	}

	var d_url = url;
	var d_clientId = clientId;
	var d_isReady = false;
	var d_debug = !!debug;

	var d_activeClient = null;
	var d_clientQueue = [];

	var d_mqttClient = mqtt.connect(url, {
		clientId: d_clientId,
		will: {
			topic: 'skynet/clients/endpoint-disconnect',
			payload: d_clientId,
			qos: 1,
			retain: false
		}
	});

	d_mqttClient.on('connect', function () {
		d_isReady = true;
		d_mqttClient.subscribe('skynet/control/#');
		d_mqttClient.subscribe('skynet/clients/#');
		if (d_debug) {
			console.log('[SkynetEndpoint] Connected to MQTT Broker');
		}
		d_mqttClient.publish('skynet/clients/endpoint-connect', d_clientId);
		this.emit('ready');
	}.bind(this));

	d_mqttClient.on('close', function () {
		// Clean up

	});

	d_mqttClient.on('message', function (topic, message) {
		var clientId;
		var pubMsg;

		if (CONTROL_REGEX.test(topic)) {
			var matches = CONTROL_REGEX.exec(topic);
			switch (matches[1]) {
				case 'digital': {
					this.emit('digitalOutput', {
						channel: parseInt(matches[2], 10),
						value: (message.toString() === '1')
					});
				} break;
				case 'pwm': {
					this.emit('pwmOutput', {
						channel: parseInt(matches[2], 10),
						value: parseFloat(message.toString())
					});
				} break;
				default: {

				}
			}
		}
		else if (topic === 'skynet/clients/register') {
			// Registration Message
			clientId = message.toString();
			// Add to the queue if it isn't already there
			if (d_clientQueue.indexOf(clientId) === -1) {
				d_clientQueue.push(clientId);
			}

			if (d_clientQueue.length === 1) {
				// The new client is the active client
				d_activeClient = clientId;
				this.emit('activeClientChanged', d_clientId);
			}

			pubMsg = {
				activeClientId: d_activeClient,
				queue: d_clientQueue
			};

			d_mqttClient.publish('skynet/clients/active-client', JSON.stringify(pubMsg));
		}
		else if (topic === 'skynet/clients/client-disconnect') {
			// Client Disconnection
			clientId = message.toString();
			var cIdx = d_clientQueue.indexOf(clientId);
			var oldActiveClient = d_activeClient;

			if (cIdx !== -1) {
				d_clientQueue.splice(cIdx, 1);
			}

			if (d_clientQueue.length > 0) {
				d_activeClient = d_clientQueue[0];
			}
			else {
				d_activeClient = null;
			}

			pubMsg = {
				activeClientId: d_activeClient,
				queue: d_clientQueue
			};

			d_mqttClient.publish('skynet/clients/active-client', JSON.stringify(pubMsg));

			if (oldActiveClient !== d_activeClient) {
				this.emit('activeClientChanged', d_activeClient);
			}
		}
	}.bind(this));

	// ==== Public Interface ====
	this.isReady = function() {
		return d_isReady;
	};

	this.setDebug = function (val) {
		d_debug = !!val;
	};

	this.publishDigital = function (channel, value) {
		d_mqttClient.publish('skynet/robot/sensors/digital/' + channel, (value ? '1':'0'));
	};

	this.publishAnalog = function (channel, value) {
		d_mqttClient.publish('skynet/robot/sensors/analog/' + channel, value.toString());
	};

	this.publishStatus = function (category, status) {
		d_mqttClient.publish('skynet/robot/status/' + category, status.toString());
	};

	this.shutdown = function () {
		d_mqttClient.pubish('skynet/clients/endpoint-disconnect', d_clientId);
		d_mqttClient.end();
	};
}

util.inherits(SkynetEndpoint, events.EventEmitter);

function SkynetClient(url, clientId, debug) {
	// Make this class an event emitter
	events.EventEmitter.call(this);

	if (clientId === undefined) {
		clientId = 'skynet_cc_' + Math.random().toString(16).substr(2,5);
	}

	var d_url = url;
	var d_clientId = clientId;
	var d_isReady = false;
	var d_debug = !!debug;

	var d_isActiveClient = false;
	var d_currentQueue = null;

	var d_endpointConnected = false;

	var d_mqttClient = mqtt.connect(url, {
		clientId: d_clientId,
		will: {
			topic: 'skynet/clients/client-disconnect',
			payload: d_clientId,
			qos: 1,
			retain: false
		}
	});

	d_mqttClient.on('connect', function () {
		d_isReady = true;
		d_mqttClient.subscribe('skynet/robot/#');
		d_mqttClient.subscribe('skynet/clients/#');
		if (d_debug) {
			console.log('[SkynetClient] Connected to MQTT Broker');
		}
		d_mqttClient.publish('skynet/clients/register', d_clientId);
		this.emit('ready');
	}.bind(this));

	d_mqttClient.on('message', function (topic, message) {
		var matches;
		if (SENSOR_REGEX.test(topic)) {
			matches = SENSOR_REGEX.exec(topic);
			switch (matches[1]) {
				case 'digital': {
					this.emit('digitalInput', {
						channel: parseInt(matches[2], 10),
						value: (message.toString() === '1' || message.toString() === 'true')
					});
				} break;
				case 'analog': {
					this.emit('analogInput', {
						channel: parseInt(matches[2], 10),
						value: parseFloat(message.toString())
					});
				} break;
				default: {

				}
			}
		}
		else if (STATUS_REGEX.test(topic)) {
			matches = STATUS_REGEX.exec(topic);
			this.emit('robotStatusUpdated', {
				category: matches[1],
				message: message.toString()
			});
		}
		else if (topic === 'skynet/clients/active-client') {
			if (!d_endpointConnected) {
				d_endpointConnected = true;
			}

			var activeClientInfo = JSON.parse(message.toString());
			console.log('[SkynetClient] ActiveClientInfo: ', activeClientInfo);
			var wasActiveClient = d_isActiveClient;
			if (d_clientId === activeClientInfo.activeClientId) {
				d_isActiveClient = true;
			}
			else {
				d_isActiveClient = false;
			}
			d_currentQueue = activeClientInfo.queue;

			if (d_isActiveClient !== wasActiveClient) {
				this.emit('activeClientStatusChanged', d_isActiveClient);
			}
		}
		else if (topic === 'skynet/clients/endpoint-disconnect') {
			d_endpointConnected = false;
			this.emit('endpointDisconnected');
		}
		else if (topic === 'skynet/clients/endpoint-connect') {
			// we'll get this if the endpoint reconnected while we are
			// connected to the broker
			d_endpointConnected = true;
			// re-register with the endpoint
			d_mqttClient.publish('skynet/clients/register', d_clientId);
			
			this.emit('endpointConnected');
		}
	}.bind(this));

	// ==== Public Interface ====
	this.isReady = function () {
		return d_isReady;
	};

	this.endpointConnected = function () {
		return d_endpointConnected;
	};

	this.isActiveClient = function () {
		return d_isActiveClient;
	};

	this.getQueuePosition = function () {
		if (!d_currentQueue) {
			return d_currentQueue.indexOf(d_clientId);
		}
		else {
			return -1;
		}
	};

	this.publishDigital = function (channel, value) {
		if (!d_isActiveClient) {
			return;
		}
		d_mqttClient.publish('skynet/control/digital/' + channel, (value ? '1':'0'));
	};

	this.publishAnalog = function (channel, value) {
		if (!d_isActiveClient) {
			return;
		}
		d_mqttClient.publish('skynet/control/analog/' + channel, value.toString());
	};

	this.publishPwm = function (channel, value) {
		if (!d_isActiveClient) {
			return;
		}
		d_mqttClient.publish('skynet/control/pwm/' + channel, value.toString());
	};

	this.shutdown = function () {
		d_mqttClient.pubish('skynet/clients/client-disconnect', d_clientId);
		d_mqttClient.end();
	};
}

util.inherits(SkynetClient, events.EventEmitter);

module.exports = {
	Client: SkynetClient,
	Endpoint: SkynetEndpoint
};