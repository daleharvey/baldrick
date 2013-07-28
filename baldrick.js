#!/usr/bin/env node

/*jshint node:true */

"use strict";

var sys = require('sys');
var fs = require('fs');
var path = require('path');
var url = require('url');
var exec = require('child_process').exec;

var commander = require('commander');
var mkdirp = require('mkdirp');
var express = require('express');
var request = require('request');

var logger = require('./baldrick-log.js');

var app = express();
app.use(express.bodyParser());

var github;
var repo;
var webhook;

// Where we clone the repositories
var WORKSPACES_DIR = path.resolve(__dirname, 'workspaces');
var TEST_SCRIPT_PATH = 'scripts/baldrick-test.sh';
var GITHUB_API = 'https://api.github.com';
var BUILD_STATUS_PATH = 'master.status';

app.get('/', function(req, res) {
  res.writeHead(200, {'Content-Type': 'text/plain'});
  res.end('Catch you on the flip side\n');
});

app.get('/workspaces/:id/baldrick.log', function(req, res) {
  var filePath = './workspaces/' + req.params.id + '/baldrick.log';
  res.setHeader('Content-Type', 'text/plain');
  fs.createReadStream(filePath).pipe(res);
});

app.get('/master.status', function(req, res) {
  res.setHeader('Content-Type', 'text/plain');
  fs.createReadStream('master.status').pipe(res);
});

app.post('/webhook', function(req, res) {

  logger.info('Received webhook');

  // We stream the log output as the test runss, make sure it doesnt time out
  req.socket.setTimeout(86400 * 1000);

  var job = {
    state: 'pending'
  };

  if (req.body.action && (req.body.action === 'opened' ||
                          req.body.action === 'synchronize')) {
    job.pull_request = true;
    job.sha = req.body.pull_request.head.sha;
    // Testing pull requests as patches on master
    job.branch = 'master';
    job.patch_url = req.body.pull_request.patch_url;
    job.id = repo.name + '-PR-' + job.branch + '-' + job.sha;
  } else if (req.body.ref) {
    job.branch = req.body.ref.split('/').pop();
    job.id = repo.name + '-' + job.branch + '-' + req.body.after;
  }

  job.workspace = path.resolve(WORKSPACES_DIR, job.id);
  job.url = 'http://' + webhook.host + '/workspaces/' + job.id + '/baldrick.log';

  logger.info(job);

  mkdirp.sync(job.workspace);
  var log = fs.createWriteStream(path.resolve(job.workspace, 'baldrick.log'));

  cloneRepo(job, log, res);
});

function streamProcessOutput(process, res, log) {
  process.stdout.pipe(res, {end: false});
  process.stdout.pipe(log, {end: false});
  process.stderr.pipe(res, {end: false});
  process.stderr.pipe(log, {end: false});
}

function setPullRequestStatus(job) {
  logger.info('Updating status', job.state);
  github({
    method: 'POST',
    uri: GITHUB_API + '/repos/' + repo.owner + '/' + repo.name + '/statuses/' + job.sha,
    json: {
      state: job.state,
      target_url: job.url,
    }
  }, function(err, res, body) {
    if (res.statusCode) {
      logger.info('Set status:', job.state);
    }
  });

}

function copyFile(srcFile, destFile) {
  var content = fs.readFileSync(srcFile);
  fs.writeFileSync(destFile, content);
}

function runTest(log, res, job) {

  if (job.pull_request) {
    setPullRequestStatus(job);
  }

  // Currently path to test is hardcoded, will need to add ability
  // to configure this
  var testPath = path.resolve(job.workspace, repo.name, TEST_SCRIPT_PATH);
  var opts = {cwd: path.resolve(job.workspace, repo.name)};

  // WARNING
  // this copies over some scripts from the baldrick repo into the
  // workspace, it should be deleted however running tests on a pull
  // request currently enables people to run arbitrary code on my machine
  // so use hardcoded test runner until we get vm's running
  var couchScriptPath = path.resolve(job.workspace, repo.name,
                                     'scripts/start_standalone_couch.sh')
  mkdirp(path.resolve(job.workspace, repo.name, 'scripts'));
  copyFile(__dirname + '/baldrick-test.sh', testPath);
  copyFile(__dirname + '/start_standalone_couch.sh', couchScriptPath);
  fs.chmodSync(testPath, '0755');
  fs.chmodSync(couchScriptPath, '0755');


  logger.info('Running test:', testPath);

  var test = exec(testPath, opts);
  streamProcessOutput(test, res, log);

  test.on('exit', function(exit) {
    logger.info('Test completed with exit status: ' + exit);
    var success = (exit === 0);
    job.state = success ? 'success' : 'failure';
    res.end(job.state + '\n');

    if (job.branch === 'master') {
      fs.writeFileSync(BUILD_STATUS_PATH, job.state + '\n');
    }

    if (success) {
      logger.info('TEST PASSED');
    } else {
      logger.error('TEST FAILED');
    }

    if (job.pull_request) {
      setPullRequestStatus(job);
    }

  });
}

function cloneRepo(job, log, res) {
  var cmd = 'git clone ' + repo.url + ' -b ' + job.branch + ' ' + repo.name;
  if (job.pull_request) {
    cmd += ' && curl ' + job.patch_url + ' | git apply -';
  }
  logger.info('Cloning:', cmd);
  logger.info('From:', job.workspace);

  var clone = exec(cmd, {cwd: job.workspace});
  streamProcessOutput(clone, res, log);
  clone.on('exit', function(exit) {
    if (exit === 0) {
      runTest(log, res, job);
    } else {
      logger.error('Error cloning:', repo.url, 'for', repo.name);
      res.end('Failed to clone project\n');
    }
  });
}

function configureWebHook() {
  logger.info('Configuring webhook');
  github({
    method: 'POST',
    uri: GITHUB_API + '/repos/' + repo.owner + '/' + repo.name + '/hooks',
    json: {
      name: 'web',
      active: true,
      events: ['push', 'pull_request'],
      config: {
        url: commander.webhook,
        content_type: 'json'
      }
    }
  }, function(err, res, body) {
    if (res.statusCode === 422) {
      logger.info('Webhook already exists');
    } else if (res.statusCode === 201) {
      logger.info('Webhook enabled');
    } else {
      logger.error('Error creating webhook');
      logger.error(body);
    }
  });
}

commander
  .version('0.0.1')
  .option('-u, --username [value]', 'Github username')
  .option('-p, --password [value]', 'Github password')
  .option('-h, --webhook [value]', 'Url for githhub to send webhooks')
  .option('-r, --repo [value]', 'Url to repository to watchl ' +
          'ie: http://github.com/daleharvey/pouchdb')
  .parse(process.argv);

if (!commander.repo) {
  logger.info('Repository (--repo=) param not passed, required');
  process.exit(1);
}

var repoUrl = url.parse(commander.repo);
var repoPath = repoUrl.path.split('/');

webhook = url.parse(commander.webhook);
repo = {
  url: repoUrl.href,
  owner: repoPath[1],
  name: repoPath[2],
};

if (commander.username && commander.password && commander.webhook && commander.repo) {
  github = request.defaults({
    json: true,
    auth: {
      username: commander.username,
      password: commander.password
    }
  });
  configureWebHook();
} else {
  logger.info('No project details, skipping webhook configuration');
}

app.listen(3000);