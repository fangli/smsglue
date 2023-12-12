const os = require('os');
const fs = require('fs');
const path = require('path')
const log = require('npmlog');
const crypto = require('crypto');
const moment = require('moment');
const momenttz = require('moment-timezone');
const request = require('request');

function SMSglue(token, origin = '') {
  this.token = token;
  this.origin = origin;
  this.user = false;
  this.pass = false;
  this.did = false;
  this.dst = false;
  this.msg = false;
  this.valid = false;
  this.id = false;
  
  try {

    // Decode and parse token JSON to object
    var decryptedToken = SMSglue.decrypt(this.token.split('-')[1]);

    // Save token values
    this.user = decryptedToken.user.trim();
    this.pass = decryptedToken.pass.trim();
    this.did = decryptedToken.did.replace(/\D/g,'');

    // Determine identifer from DID
    this.id = this.did.substring(6) + '-' + SMSglue.encrypt(this.did);

  } catch(e) {}

  // Validate token values (username is email address, password 8 charactors or more, did 10 digits)
  this.valid = ((this.user.toString().includes('@')) && (this.pass.toString().length >= 8) && (this.did.toString().length == 10)) ? true : false;

  this.hooks = {

    // This URL must be manually entered into Acrobits Softphone/Groundwire to enabled the next URLs
    provision: `${this.origin}/provision/${this.id}`,

    // Acrobits calls this URL to send us the push token and app id (needed for notifications)
    report: `${this.origin}/report/${this.id}/%selector%/%pushToken%/%pushappid%`,

    // This URL is added to voip.ms to be called whenever a new SMS is received (it deletes the local cache of SMSs)
    notify: `${this.origin}/notify/${this.id}?from={FROM}&message={MESSAGE}`,

    // Acrobits refresh the list of SMSs with this URL whenever the app is opened or a notification is received
    fetch: `${this.origin}/fetch/${this.token}/%last_known_sms_id%`,

    // Acrobits submits to this URL to send SMS messages
    send: `${this.origin}/send/${this.token}/%sms_to%/%sms_body%`

  }
}


// STATIC FUNCTIONS

SMSglue.save = function(type, id, value, cb = function(){}) {
  var filename = path.resolve('cache', type, id);
  fs.writeFile(filename, value, 'utf8', cb);
}

SMSglue.load = function(type, id, cb = function(){}) {
  var filename = path.resolve('cache', type, id);
  fs.readFile(filename, 'utf8', cb);
}

SMSglue.clear = function(type, id, cb = function(){}) {
  var filename = path.resolve('cache', type, id);
  fs.unlink(filename, cb);
}

// Get crypto key (and generate if it doesn't exist yet)
SMSglue.load('key', 'key', (err, key) => {
  SMSglue.KEY = key;
  if (err) {
    SMSglue.KEY = crypto.randomBytes(32);
    SMSglue.save('key', 'key', SMSglue.KEY);
  }
});
SMSglue.ALGO = 'aes-256-cbc';

SMSglue.IV = new Buffer.from(crypto.randomBytes(16));

SMSglue.encrypt = function(text, salt=false) {
  var cipher = crypto.createCipheriv(SMSglue.ALGO, SMSglue.KEY, SMSglue.IV);
  var crypted = cipher.update(JSON.stringify(text), 'utf8', 'hex');
  crypted += cipher.final('hex');
  return crypted;
}

SMSglue.decrypt = function(text, salt=false) {
  try {
    var decipher = crypto.createDecipheriv(SMSglue.ALGO, SMSglue.KEY, SMSglue.IV);
    var decrypted = decipher.update(text, 'hex', 'utf8')
    decrypted += decipher.final('utf8');
    return JSON.parse(decrypted);

  } catch(e) {
    return false;
  }
}

SMSglue.date = function(d=undefined) {
  return moment.utc(d).format("YYYY-MM-DDTHH:mm:ss.SSZ");
}

// Parse request body, return object only if valid JSON and status == 'success'
SMSglue.parseBody = function(body) {
  try {
    body = JSON.parse(body);
    return (body.status == 'success') ? body : false;

  } catch(e) {
    return false;
  }
} 

// Send notification messages to all devices under this account
SMSglue.notify = function(id, query, cb) {

  // Read the cached push token and app id
  SMSglue.load('devices', id, (err, encrypted) => {

    // Decrypt and prep
    var sent = 0, hasError = false, validDevices = [];
    var devices = SMSglue.decrypt(encrypted) || [];
    log.info('notify', `devices count: ${devices.length}`);
    // No devices to notify, hit the callback now
    if (!devices.length) cb();

    // This will be called after each request, but only do anything after the final request
    var updateCachedDevices = function() {
      log.info('updateCachedDevices', `sent count: ${sent}`);
      
      // If number of messages sent matches the number of devices...
      if (sent >= devices.length) {
        log.info('updateCachedDevices', 'sent matches device length');

        // If there was a push error, rewrite the devices file with on the valid devices
        if (hasError) {
          SMSglue.save('devices', id, SMSglue.encrypt(validDevices));
        }

        // All finished, hit the callback
        cb();
      }
    }

    // Send push notification to all devices on this account
    devices.forEach((device) => {

      request({
        method: 'POST',
        url: 'https://pnm.cloudsoftphone.com/pnm2/send',
        json: {
          verb: 'NotifyTextMessage',
          AppId: device.AppId,
          DeviceToken: device.DeviceToken,
          Selector: device.Selector,
          Badge: 1,
          UserName: query.from,
          Sound: 'default',
          Message: query.message,
        }
      }, (error) => {
        sent++;
        if (error) hasError = true;
        else validDevices.push(device);
        updateCachedDevices();
      });
    });
  });
}


// INSTANCE METHODS

SMSglue.prototype.request = function(query = {}, callback) {
  let options = {
    method: 'GET',
    url: 'https://www.voip.ms/api/v1/rest.php',
    headers: {
      'User-Agent': 'smsglue',
    },
    qs: {
      api_username: this.user,
      api_password: this.pass,
      did: this.did
    }
  };
  Object.assign(options.qs, query);
  // log.info('request', options);
  request(options, callback);
}


// Enable SMS messages in voip.ms account and set SMS URL Callback
SMSglue.prototype.enable = function(cb) {
  var URL =  this.hooks.notify;
  this.request({ 
    method: 'setSMS',
    enable: 1,
    url_callback_enable: 1,
    url_callback: URL,
    url_callback_retry: 1
  }, cb);
}

// Send SMS message
SMSglue.prototype.send = function(dst, msg, cb) {

  // Clean up number and message text
  dst = dst.replace(/\D/g,'');
  msg = msg.trim();

  // Remove leading '1' on 11-digit phone numbers
  if ((dst.length == 11) && (dst.charAt(0) == '1')) {
    dst = dst.slice(1);
  }

  // Validate destination number and message text
  if ((dst.length != 10) || (msg.length < 1))  { 
    cb(true);
    return;
  }

  // Recursively send 160 character chunks
  var sendMessage = (message = '') => {
    // log.info(`${this.did} -> ${dst}`, message);

    var thisMessage = message.substring(0, 160);
    var nextMessage = message.substring(160);
    var callback = (nextMessage.length) ? () => { sendMessage(nextMessage) } : cb; 

    // Submit request to send message
    this.request({ 
      method: 'sendSMS',
      dst: dst,
      message: thisMessage,
    }, callback);
  }

  // Start it off
  sendMessage(msg);
}


// Get SMS messages
SMSglue.prototype.get = function(cb) {

  // Query voip.ms for received SMS messages ranging from 90 days ago to tomorrow
  this.request({ 
    method: 'getSMS',
    from: moment.utc().subtract(90, 'days').format('YYYY-MM-DD'),
    to: moment.utc().add(1, 'day').format('YYYY-MM-DD'),
    limit: 9999,
    type: 1,
    timezone: (momenttz.tz('America/Edmonton').isDST()) ? -1 : 0

  // Wait for it... 
  }, (err, r, body) => {

    // Go on if there aren't any errors in the body
    if (body = SMSglue.parseBody(body)) {

      // Collect all SMS messages in an array of objects with the proper keys and formatting
      var smss = body.sms.map( (sms) => {
        return {
          sms_id: Number(sms.id),
          sending_date: SMSglue.date(sms.date),
          sender: sms.contact.replace(/\D/g,''),
          sms_text: sms.message
        }
      });

      // Save this as a encrypted json file and hit the callback when done
      SMSglue.save('messages', this.id, SMSglue.encrypt(smss, this.pass), cb);

    // Whoops, there was an error. Hit the callback with the error argument true
    } else {
      cb(true);
    }
  
  });
}


SMSglue.prototype.accountXML = function() {
  xml  = '<account>';

  if (this.valid) {
    if (this.hooks.report) xml += `<pushTokenReporterUrl>${this.hooks.report}</pushTokenReporterUrl>`;
    if (this.hooks.fetch)  xml += `<genericSmsFetchUrl>${this.hooks.fetch}</genericSmsFetchUrl>`;
    if (this.hooks.send)   xml += `<genericSmsSendUrl>${this.hooks.send}</genericSmsSendUrl>`;
    xml += '<allowMessage>1</allowMessage>';
    xml += '<voiceMailNumber>*97</voiceMailNumber>';
  }

  xml += '</account>';
  return xml;
}

module.exports = SMSglue;
