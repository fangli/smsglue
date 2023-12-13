const os = require('os');
const fs = require('fs');
const path = require('path')
const log = require('npmlog');
const crypto = require('crypto');
const moment = require('moment');
const momenttz = require('moment-timezone');
const request = require('request');
const { json } = require('body-parser');

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
    var decryptedToken = SMSglue.decrypt(this.token.split('-')[1]);
    this.user = decryptedToken.user.trim();
    this.pass = decryptedToken.pass.trim();
    this.did = decryptedToken.did.replace(/\D/g,'');
    this.id = this.did.substring(6) + '-' + SMSglue.encrypt(this.did);
  } catch(e) {}

  this.valid = ((this.user.toString().includes('@')) && (this.pass.toString().length >= 8) && (this.did.toString().length == 10)) ? true : false;

  this.hooks = {
    provision: `${this.origin}/provision/${this.id}`,
    report: `${this.origin}/device/${this.id}/%selector%/%pushToken%/%pushappid%`,
    notify: `${this.origin}/notify/${this.id}?from={FROM}&message={MESSAGE}`,
    fetch: `${this.origin}/fetch/${this.token}/%last_known_sms_id%`,
    send: `${this.origin}/send/${this.token}/%sms_to%/%sms_body%`
  }
}


SMSglue.save = function(type, id, value, cb = function(){}) {
  var filename = path.resolve('cache', type, id);
  fs.writeFile(filename, JSON.stringify(value), 'utf8', cb);
}

SMSglue.load = function(type, id, cb = function(){}) {
  var filename = path.resolve('cache', type, id);
  fs.readFile(filename, 'utf8', function(err, data) {
    data = (err) ? false : JSON.parse(data);
    cb(err, data);
  });
}

SMSglue.clear = function(type, id, cb = function(){}) {
  var filename = path.resolve('cache', type, id);
  fs.unlink(filename, cb);
}

SMSglue.load('ciphers', 'secrets', (err, secrets) => {
  if (err) {
    SMSglue.ALGO = 'aes-128-cbc';
    SMSglue.KEY = crypto.randomBytes(16);
    SMSglue.IV = crypto.randomBytes(16);
    SMSglue.save('ciphers', 'secrets', {'algo': SMSglue.ALGO, 'key': SMSglue.KEY.toString('hex'), 'iv': SMSglue.IV.toString('hex')});
  } else {
    SMSglue.ALGO = secrets.algo;
    SMSglue.KEY = Buffer.from(secrets.key, 'hex');
    SMSglue.IV = Buffer.from(secrets.iv, 'hex');
  }
});

SMSglue.encrypt = function(text) {
  var cipher = crypto.createCipheriv(SMSglue.ALGO, SMSglue.KEY, SMSglue.IV);
  var crypted = cipher.update(JSON.stringify(text), 'utf8', 'hex');
  crypted += cipher.final('hex');
  return crypted;
}

SMSglue.decrypt = function(text) {
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

SMSglue.parseBody = function(body) {
  try {
    body = JSON.parse(body);
    return (body.status == 'success') ? body : false;

  } catch(e) {
    return false;
  }
} 

SMSglue.notify = function(id, query, cb) {
  SMSglue.load('devices', id, (err, encrypted) => {
    var sent = 0, hasError = false, validDevices = [];
    var devices = SMSglue.decrypt(encrypted) || [];
    if (!devices.length) {
      info.warn('NewSMS', `Received message "${query.message}" from ${query.from}, but devices found!`);
      cb();
    }

    var updateCachedDevices = function() {
      if (sent >= devices.length) {
        if (hasError) {
          SMSglue.save('devices', id, SMSglue.encrypt(validDevices));
        }
        cb();
      }
    }

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
        if (error) {
          hasError = true;
        } else {
          validDevices.push(device);
        }
        updateCachedDevices();
      });
    });
  });
}


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
  request(options, callback);
}


// Activate SMS messages in voip.ms account and set SMS URL Callback
SMSglue.prototype.activate = function(cb) {
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
  dst = dst.replace(/\D/g,'');
  msg = msg.trim();
  if ((dst.length == 11) && (dst.charAt(0) == '1')) {
    dst = dst.slice(1);
  }
  if ((dst.length != 10) || (msg.length < 1))  { 
    cb(true);
    return;
  }

  var sendMessage = (message = '') => {
    var thisMessage = message.substring(0, 160);
    var nextMessage = message.substring(160);
    var callback = (nextMessage.length) ? () => { sendMessage(nextMessage) } : cb; 
    this.request({ 
      method: 'sendSMS',
      dst: dst,
      message: thisMessage,
    }, callback);
  }
  sendMessage(msg);
}


// Get SMS messages
SMSglue.prototype.get = function(cb) {

  this.request({ 
    method: 'getSMS',
    from: moment.utc().subtract(90, 'days').format('YYYY-MM-DD'),
    to: moment.utc().add(1, 'day').format('YYYY-MM-DD'),
    limit: 9999,
    type: 1,
    timezone: (momenttz.tz('America/Edmonton').isDST()) ? -1 : 0
  }, (err, r, body) => {

    if (body = SMSglue.parseBody(body)) {
      var smss = body.sms.map( (sms) => {
        return {
          sms_id: Number(sms.id),
          sending_date: SMSglue.date(sms.date),
          sender: sms.contact.replace(/\D/g,''),
          sms_text: sms.message
        }
      });
      SMSglue.save('messages', this.id, SMSglue.encrypt(smss, this.pass), cb);
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
