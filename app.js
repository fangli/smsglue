const fs = require('fs');
const path = require('path');
const log = require('npmlog');
const port = 2777;

var SMSglue = require('./smsglue');

var app = require('express')();
var bodyParser = require('body-parser');
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

app.post('/activate', (req, res) => {
  log.info('activating', req.body.user, req.body.did);
  let token = req.body.did.substring(6) + '-' + 
    SMSglue.encrypt({
      user: req.body.user,
      pass: req.body.pass,
      did: req.body.did
    });

  let glue = new SMSglue(token, req.body.origin);

  glue.activate((err, r, body) => {
    if (body = SMSglue.parseBody(body)) {
      SMSglue.save('provisions', glue.id, SMSglue.encrypt(glue.accountXML()), () => {
        log.info('activated', req.body.user, req.body.did);
        res.setHeader('Content-Type', 'application/json');
        res.send({ response: { error: 0, description: 'Success', hooks: glue.hooks }});
      });
    } else {
        log.info('Failed Activation', req.body.user, req.body.did);
        res.setHeader('Content-Type', 'application/json');
      res.send({ response: { error: 400, description: 'Invalid parameters' }});
    }
  });
});


app.get('/provision/:id', (req, res) => {
  SMSglue.load('provisions', req.params.id, (err, encrypted) => {
    var xml = SMSglue.decrypt(encrypted) || '<account></account>';
    log.info('provision', req.params.id);
    res.setHeader('Content-Type', 'text/xml');
    res.send(xml);
  });
});


app.get('/notify/:id', (req, res) => {
  SMSglue.clear('messages', req.params.id, (err) => {
    SMSglue.notify(req.params.id, req.query, () => {
      log.info('notify', req.params.id, `Send notification for SMS from ${req.query.from}`);
      res.setHeader('Content-Type', 'text/plain');
      res.send('ok');
    });
  });
});


app.get('/device/:id/:selector/:device/:app', (req, res) => {
  SMSglue.load('devices', req.params.id, (err, encrypted) => {
    var devices = SMSglue.decrypt(encrypted) || [];
    if ((req.params.device) && (req.params.app) && (req.params.selector)) {
      devices.push({
        DeviceToken: req.params.device,
        AppId: req.params.app,
        Selector: req.params.selector
      });
    }
    devices = devices.filter((device, index, self) => self.findIndex((d) => {return d.DeviceToken === device.DeviceToken }) === index)
    SMSglue.save('devices', req.params.id, SMSglue.encrypt(devices), (err) => {
      log.info('device', req.params.id, `Device registered ${req.params.selector}`);
      res.setHeader('Content-Type', 'application/json');
      res.send({ response: { error: 0, description: 'Success' }});
    });
  });
});


app.get(['/fetch/:token/:last_sms','/fetch/:token'], (req, res) => {
  var glue = new SMSglue(req.params.token);
  var last_sms = Number(req.params.last_sms) || 0;

  var fetchFilteredSMS = function(smss) {
    res.setHeader('Content-Type', 'application/json');
    res.send({
      date: SMSglue.date(),
      unread_smss: smss.filter((sms) => (Number(sms.sms_id) > last_sms))
    });
  }

  SMSglue.load('messages', glue.id, (err, data) => {
    var smss = SMSglue.decrypt(data) || [];
    if (smss.length) {
      log.info('fetchSMS', glue.id, `Fetched ${smss.length} SMS from local cache`);
      fetchFilteredSMS(smss);
    } else {
      glue.get((error) => {
        SMSglue.load('messages', glue.id, (err, data) => {
          smss = SMSglue.decrypt(data) || [];
          log.info('fetchSMS', glue.id, `Fetched ${smss.length} SMS from remote server`);
          fetchFilteredSMS(smss);
        });
      });
    }
  });   
});

app.get('/send/:token/:dst/:msg', (req, res) => {
  let glue = new SMSglue(req.params.token);
  glue.send(req.params.dst, req.params.msg, (err, r, body) => {
    body = SMSglue.parseBody(body);
    if ((body) && (!err)) {
      log.info('sendSMS', glue.id, `Sent SMS to ${req.params.dst}`);
      res.setHeader('Content-Type', 'application/json');
      res.send({ response: { error: 0, description: 'Success' }});
    } else {
      log.info('sendSMS', glue.id, `Failed to send SMS to ${req.params.dst}`);
      res.setHeader('Content-Type', 'application/json');
      res.send({ response: { error: 400, description: 'Invalid parameters' }});
    }
  });
});

app.get('/', (req, res) => {
  fs.readFile(path.resolve(__dirname, 'index.html'), 'utf8', (err, data) => {
    data = (process.env.BEFORE_CLOSING_BODY_TAG) ? data.replace("</body>", `${process.env.BEFORE_CLOSING_BODY_TAG}\n</body>`) : data;
    res.setHeader('Content-Type', 'text/html');
    res.send(data);
  });
});

app.get('*', (req, res) => {
  res.status(404).send("Page not found!")
});


app.set('env', 'production');
app.listen(port, () => {
  console.log(`App listening on port ${port}`)
})
