// modules
var url = require('url');
var crypto = require('crypto');
var fs = require('fs');
var path = require('path');
// local requirements
var logger = require('../lib/logging').logger;
var configuration = require('../lib/configuration');
var baker = require('../lib/baker');
var remote = require('../lib/remote');
var awardBadge = require('../lib/award');

/**
 * Fully qualify a url.
 *
 * @param {String} pathOrUrl either a path like /what.html or a full url
 * @param {String} origin a full quallified url
 * @return {String} a fully qualified url, using parts from the origin if
 *   the original `pathOrUrl` was just a path.
 */
function qualifyUrl (pathOrUrl, origin) {
  var parts = url.parse(pathOrUrl);
  if (!parts.hostname) {
    var originParts = url.parse(origin);
    parts.host = originParts.host;
    parts.port = originParts.port;
    parts.slashes = originParts.slashes;
    parts.protocol = originParts.protocol;
    parts.hostname = originParts.hostname;
  }
  return url.format(parts);
}

/**
 * md5 hashes some data without all the rigmarole.
 *
 * @param {String} data the input you want hashed
 * @return {String} the quality output you've come to expect
 */
function quickmd5 (data) {
  var md5sum = crypto.createHash('md5');
  return md5sum.update(data).digest('hex');
}

exports.baker = function(req, res) {
  var query = req.query || {};
  var assertionUrl = query.assertion;
  
  // render the badge baker frontend and bounce if no assertion was passed
  if (!assertionUrl)
    return res.render('baker', { title: 'Creator', login: false });
  
  // all errors get reported as json. we will explicitly set the
  // content-type to image/png on success.
  res.setHeader('Content-Type', 'application/json');
  
  remote.getHostedAssertion(assertionUrl, function(err, assertion) {
    // bail if we get an error from `getHostedAssertion`, convert error
    // object to json and pass it back.
    if (err) {
      logger.warn('failed grabbing assertion for URL '+ assertionUrl);
      logger.warn('reason: '+ JSON.stringify(err));
      return res.send(JSON.stringify(err), 400)
    }
    
    // if the url for the image isn't fully qualified, parse what we have
    // and fill out the rest from `issuer.origin`
    try {
      var badge = assertion.badge;
      // #TODO: use badge.issuer.origin here.
      var imageUrl = qualifyUrl(badge.image, assertionUrl); 
    }
    
    catch (err) {
      var errorString = JSON.stringify(err);
      logger.warn('something went wrong parsing the urls');
      logger.warn(errorString);
      return res.send(errorString, 400);
    }
    
    remote.badgeImage(imageUrl, function(err, imagedata) {
      // if we can't find the badge image for whatever reason, bail and
      // return the error object as json.
      if (err) {
        logger.warn('failed grabbing badge image '+ imageUrl);
        logger.warn('reason: '+ JSON.stringify(err));
        return res.send(JSON.stringify(err), 400);
      }
      
      // there is a chance that baker.prepare could throw an error. if it
      // does, catch it and send the error message to the client.
      try {
        var imageData = baker.prepare(imagedata, query.assertion);
      }
      catch (err) {
        logger.error('failed writing data to badge image: '+ err);
        return res.send(JSON.stringify({
          status: 'failure',
          error: 'processing',
          reason: 'could not write data to PNG: ' + err
        }), 400);
      }

      // if the user agent only wants json, we'll give 'em json.
      // #XXX: this is strange, I don't remember why I built in support
      //   for this. I think it was supposed to be a really low fidelity
      //   way to do assertion validation. We should probably remove this.
      var accepts = req.headers['accept'] || '';
      if (accepts.match('application/json')) {
        res.setHeader('Content-Type', 'application/json');
        return res.send(JSON.stringify({'status':'success', 'assertion': JSON.stringify(assertion) }));
      }

      // create a unique filename from the md5 hash of the image data. this is
      // only used as the suggested filename for badge if it is being manually
      // downloaded by a user-agent.
      var filename = quickmd5(imageData) + '.png';
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Content-Disposition', 'attachment; filename="'+filename+'"');
      
      // find out if the caller wants to award the badge to a user
      // #TODO: figure out how we can retire this. going forward everyone
      //   should be using the issuer.js library
      var shouldAward = req.query.award && req.query.award !== 'false';
      if (!shouldAward) {
        return res.send(imageData);
      }
      
      else {
        // handle unhashed emails by plucking them straight from the assertion.
        // the raw value of hashed emails should be passed in as the `award`
        // query parameter.
        var email = (assertion.recipient.match(/@/) ? assertion.recipient : query.award);
        var opts = {
          assertion: assertion,
          url: assertionUrl,
          imagedata: imageData,
          recipient: email
        };
        
        logger.debug('Issuer wants to award: value for email is: ' + email);
        awardBadge(opts, function (err, badge) {
          // if there is an error, set a header saying there was a problem.
          // since the primary function of the baker is to bake, don't bail
          if (err) {
            logger.debug('There was an error awarding');
            logger.debug(JSON.stringify(err));
            res.setHeader('x-badge-awarded', 'false');
          }
          
          // set the awarded header to be the recipient if badge was awarded
          else {
            logger.debug('Badge was awarded just fine');
            logger.debug(JSON.stringify(badge));
            res.setHeader('x-badge-awarded', badge.get('recipient'));
          }
          return res.send(imageData);
        });
      }
    });
  });
};
