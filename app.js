const fs = require('fs');
const path = require('path');
const log = require('npmlog');
const port = 2777;

var SMSglue = require('./smsglue');

var express = require('express');
var app = express();
var bodyParser = require('body-parser');
var server = require('http').createServer(app);

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

var TIMER = {};

app.post('/enable', (req, res) => {
  log.info('Action', 'enable');

  let token = req.body.did.substring(6) + '-' + 
    SMSglue.encrypt({
      user: req.body.user || '',
      pass: req.body.pass || '',
       did: req.body.did  || ''
    });

  let glue = new SMSglue(token, req.body.origin || '');
  glue.enable( (err, r, body) => {

    if (body = SMSglue.parseBody(body)) {
      // log.info('Action', body);

      SMSglue.save('provisions', glue.id, SMSglue.encrypt(glue.accountXML()), () => {

        // Auto-empty this xml file (only "<account></account>") after 10 minutes of waiting...
        if (TIMER[glue.id]) clearTimeout(TIMER[glue.id]);
        TIMER[glue.id] = setTimeout(() => {
          SMSglue.save('provisions', glue.id, SMSglue.encrypt('<account></account>'));
          log.info('Provision', 'Cleared after 10 minute timeout');
        }, 600000)
      
        res.setHeader('Content-Type', 'application/json');
        res.send({ response: { error: 0, description: 'Success', hooks: glue.hooks }});
      });


    } else {
      res.setHeader('Content-Type', 'application/json');
      res.send({ response: { error: 400, description: 'Invalid parameters' }});
    }
  });
});


app.get('/provision/:id', (req, res) => {
  log.info('Action', 'provision');

  SMSglue.load('provisions', req.params.id, (err, encrypted) => {
    var xml = SMSglue.decrypt(encrypted) || '<account></account>';

    // If the file exists, empty this xml file (only "<account></account>") 
    if (!err) {
      if (TIMER[req.params.id]) clearTimeout(TIMER[req.params.id]);
      SMSglue.save('provisions', req.params.id, SMSglue.encrypt('<account></account>'));
      log.info('Provision', 'Cleared after request');
    }

    res.setHeader('Content-Type', 'text/xml');
    res.send(xml);
  });
});


app.get('/notify/:id', (req, res) => {
  log.info('Action', 'notify');
  
  // Deleted the cached history
  SMSglue.clear('messages', req.params.id, (err) => {
    log.info('Action', 'notify', 'Cleared cached messages');
    // Send push notification to device(s) 
    SMSglue.notify(req.params.id, () => {
      log.info('Action', 'notify', 'Done push notification');
      // voip.ms expects this reply, otherwise it'll retry every 30 minutes
      res.setHeader('Content-Type', 'text/plain');
      res.send('ok');

    });
  });
});


app.get('/report/:id/:device/:app', (req, res) => {
  log.info('Action', 'report');

  // Read existing devices file
  SMSglue.load('devices', req.params.id, (err, encrypted) => {
    var devices = SMSglue.decrypt(encrypted) || [];

    // Add this push token & app id to the array
    if ((req.params.device) && (req.params.app)) {
      devices.push({
        DeviceToken: req.params.device,
        AppId: req.params.app
      });
    }

    // Remove any duplicates
    devices = devices.filter((device, index, self) => self.findIndex((d) => {return d.DeviceToken === device.DeviceToken }) === index)

    // Save changes to disk
    SMSglue.save('devices', req.params.id, SMSglue.encrypt(devices), (err) => {
      res.setHeader('Content-Type', 'application/json');
      res.send({ response: { error: 0, description: 'Success' }});
    });

  });
});


// Fetch cached SMS messages, filtered by last SMS ID
app.get(['/fetch/:token/:last_sms','/fetch/:token'], (req, res) => {
  log.info('Action', 'fetch');

  var glue = new SMSglue(req.params.token);
  var last_sms = Number(req.params.last_sms) || 0;

  // log.info('last_sms', last_sms);

  // Fetch filtered SMS messages back as JSON
  var fetchFilteredSMS = function(smss) {
    res.setHeader('Content-Type', 'application/json');
    res.send({
      date: SMSglue.date(),
      unread_smss: smss.filter((sms) => (Number(sms.sms_id) > last_sms))
    });
  }

  // First try to read the cached messages
  SMSglue.load('messages', glue.id, (err, data) => {

    // Decrypt the messages and send them back
    var smss = SMSglue.decrypt(data, glue.pass) || [];
    if (smss.length) {
      // log.info(glue.did, 'Found SMS cache')
      fetchFilteredSMS(smss);

    // If the array is empty, update the cache from voip.ms and try again
    } else {
      // log.info(glue.did, 'DID NOT find SMS cache')
      glue.get((error) => {

        // Read the cached messages one more time
        SMSglue.load('messages', glue.id, (err, data) => {

          // Decrypt the messages and send them back (last chance)
          smss = SMSglue.decrypt(data, glue.pass) || [];
          fetchFilteredSMS(smss);

        });
      });
    }
  });   
});

app.get('/send/:token/:dst/:msg', (req, res) => {
  log.info('Action', 'send');

  let glue = new SMSglue(req.params.token);
  glue.send(req.params.dst, req.params.msg, (err, r, body) => {

    body = SMSglue.parseBody(body);

    if ((body) && (!err)) {
      res.setHeader('Content-Type', 'application/json');
      res.send({ response: { error: 0, description: 'Success' }});

    } else {
      res.setHeader('Content-Type', 'application/json');
      res.send({ response: { error: 400, description: 'Invalid parameters' }});
    }
  });
});

app.get('/', (req, res) => {
  log.info('Action', 'index');
  fs.readFile(path.resolve(__dirname, 'index.html'), 'utf8', (err, data) => {
    data = (process.env.BEFORE_CLOSING_BODY_TAG) ? data.replace("</body>", `${process.env.BEFORE_CLOSING_BODY_TAG}\n</body>`) : data;
    res.setHeader('Content-Type', 'text/html');
    res.send(data);
  });
});

app.get('*', (req, res) => {
  log.info('Action', 'redirect');
  res.redirect('/');
});


app.listen(port, () => {
  console.log(`App listening on port ${port}`)
})
