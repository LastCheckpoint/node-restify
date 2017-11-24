'use strict';

var EventEmitter = require('events').EventEmitter;
var util = require('util');
var http = require('http');

var _ = require('lodash');
var assert = require('assert-plus');
var errors = require('restify-errors');
var FindMyWay = require('find-my-way');

var Chain = require('./chain');
var dtrace = require('./dtrace');

///--- Globals

var MethodNotAllowedError = errors.MethodNotAllowedError;
var ResourceNotFoundError = errors.ResourceNotFoundError;

///--- API

/**
 * Router class handles mapping of http verbs and a regexp path,
 * to an array of handler functions.
 *
 * @class
 * @public
 * @param  {Object} options - an options object
 * @param  {Bunyan} options.log - Bunyan logger instance
 * @param {Boolean} [options.onceNext=false] - Prevents calling next multiple
 *  times
 * @param {Boolean} [options.strictNext=false] - Throws error when next() is
 *  called more than once, enabled onceNext option
 */
function Router(options) {
    assert.object(options, 'options');
    assert.object(options.log, 'options.log');
    assert.optionalBool(options.onceNext, 'options.onceNext');
    assert.optionalBool(options.strictNext, 'options.strictNext');

    EventEmitter.call(this);

    this.log = options.log;
    this.onceNext = !!options.onceNext;
    this.strictNext = !!options.strictNext;
    this.name = 'RestifyRouter';

    // Internals
    this._mounts = {};
    this._anonymusHandlerCounter = 0;
    this._findMyWay = new FindMyWay({
        defaultRoute: this._defaultRoute.bind(this)
    });
}
util.inherits(Router, EventEmitter);

/**
 * Lookup for route
 *
 * @public
 * @memberof Router
 * @instance
 * @function lookup
 * @param  {Request} req - request
 * @param  {Response} res - response
 * @param  {Function} next - only called when next is called in the last handler
 * @returns {undefined} no return value
 */
Router.prototype.lookup = function lookup(req, res, next) {
    var self = this;
    var url = req.getUrl().pathname;

    // Find find-my-way (fmw) route
    self._dtraceStart(req);
    var fmwRoute = self._findMyWay.find(req.method, url);
    self._dtraceEnd(req, res);

    // Not found
    if (!fmwRoute) {
        self._defaultRoute(req, res, function afterRouter(err) {
            next(err, req, res);
        });
        return;
    }

    // Decorate req
    req.params = Object.assign(req.params, fmwRoute.params);
    req.route = fmwRoute.store.route;

    // Emit routed
    self.emit('routed', req, res, req.route);

    // Call handler chain
    fmwRoute.handler(req, res, next);
};

/**
 * Lookup by name
 *
 * @public
 * @memberof Router
 * @instance
 * @function lookupByName
 * @param {String} name - route name
 * @param  {Request} req - request
 * @param  {Response} res - response
 * @param  {Function} next - only called when next is called in the last handler
 * @returns {undefined} no return value
 */
Router.prototype.lookupByName = function lookupByName(name, req, res, next) {
    var self = this;
    var route = self._mounts[name];

    if (!route) {
        self._defaultRoute(req, res);
        return;
    }

    // Decorate req
    req.route = route;

    route.chain.handle(req, res, next);
};

/**
 * Adds a route.
 *
 * @public
 * @memberof Router
 * @instance
 * @function mount
 * @param    {Object} opts - an options object
 * @param    {String} opts.name - name
 * @param    {String} opts.method - method
 * @param    {String} opts.path - path can be any String accepted by
 * [find-my-way](https://github.com/delvedor/find-my-way)
 * @param    {Function[]} handlers - handlers
 * @returns  {String} returns the route name if creation is successful.
 * @fires ...String#mount
 */
Router.prototype.mount = function mount(opts, handlers) {
    var self = this;

    assert.object(opts, 'opts');
    assert.string(opts.method, 'opts.method');
    assert.string(opts.name, 'opts.name');
    assert.arrayOfFunc(handlers, 'handlers');

    var chain = new Chain({
        onceNext: self.onceNext,
        strictNext: self.strictNext
    });

    // Route
    var route = {
        name: opts.name,
        method: opts.method,
        path: opts.path,
        spec: opts,
        chain: chain
    };

    handlers.forEach(function forEach(handler) {
        // Assign name to anonymus functions
        handler._name =
            handler.name || 'handler-' + self._anonymusHandlerCounter++;

        // Attach to middleware chain
        chain.use(handler);
    });

    self._findMyWay.on(
        route.method,
        route.path,
        function onRoute(req, res, next) {
            chain.handle(req, res, next);
        },
        {
            route: route
        }
    );

    // Store route
    self._mounts[route.name] = route;
    self.emit('mount', route.method, route.path);

    return route;
};

/**
 * Unmounts a route.
 *
 * @public
 * @memberof Router
 * @instance
 * @function unmount
 * @param    {String} name - the route name
 * @returns  {Object|undefined} removed route if found
 */
Router.prototype.unmount = function unmount(name) {
    assert.string(name, 'name');

    var route = this._mounts[name];

    if (!route) {
        return undefined;
    }

    this._findMyWay.off(route.method, route.path);
    delete this._mounts[name];
    return route;
};

/**
 * toString() serialization.
 *
 * @public
 * @memberof Router
 * @instance
 * @function toString
 * @returns  {String} stringified router
 */
Router.prototype.toString = function toString() {
    return this._findMyWay.prettyPrint();
};

/**
 * Return information about the routes registered in the router.
 *
 * @public
 * @memberof Router
 * @instance
 * @returns {object} The routes in the router.
 */
Router.prototype.getDebugInfo = function getDebugInfo() {
    return _.mapValues(this._mounts, function mapValues(route, routeName) {
        return {
            name: route.name,
            method: route.method.toLowerCase(),
            path: route.path,
            handlers: route.chain.getHandlers()
        };
    });
};

/**
 * Return mounted routes
 *
 * @public
 * @memberof Router
 * @instance
 * @returns {object} The routes in the router.
 */
Router.prototype.getRoutes = function getRoutes() {
    return this._mounts;
};

/**
 * Returns true if the router generated a 404 for an options request.
 *
 * TODO: this is relevant for CORS only. Should move this out eventually to a
 * userland middleware? This also seems a little like overreach, as there is no
 * option to opt out of this behavior today.
 *
 * @private
 * @static
 * @function _optionsError
 * @param    {Object}     req - the request object
 * @param    {Object}     res - the response object
 * @returns  {Boolean} is options error
 */
Router._optionsError = function _optionsError(req, res) {
    var pathname = req.getUrl().pathname;
    return req.method === 'OPTIONS' && pathname === '*';
};

/**
 * Default route, when no route found
 * Responds with a ResourceNotFoundError error.
 *
 * @private
 * @memberof Router
 * @instance
 * @function _defaultRoute
 * @param  {Request} req - request
 * @param  {Response} res - response
 * @param  {Function} next - next
 * @returns {undefined} no return value
 */
Router.prototype._defaultRoute = function _defaultRoute(req, res, next) {
    var self = this;
    var pathname = req.getUrl().pathname;

    // Allow CORS
    if (Router._optionsError(req, res, pathname)) {
        res.send(200);
        next(null, req, res);
        return;
    }

    // Check for 405 instead of 404
    var allowedMethods = http.METHODS.filter(function some(method) {
        return self._findMyWay.find(method, pathname);
    });

    if (allowedMethods.length) {
        res.methods = allowedMethods;
        res.setHeader('Allow', allowedMethods.join(', '));
        var methodErr = new MethodNotAllowedError(
            '%s is not allowed',
            req.method
        );
        next(methodErr, req, res);
        return;
    }

    // clean up the url in case of potential xss
    // https://github.com/restify/node-restify/issues/1018
    var err = new ResourceNotFoundError('%s does not exist', pathname);
    next(err, req, res);
};

/**
 * Setup request and calls _onRequest to run middlewares and call router
 *
 * @private
 * @memberof Router
 * @instance
 * @function _dtraceStart
 * @param    {Request}    req - the request object
 * @returns  {undefined} no return value
 * @fires Request,Response#request
 */
Router.prototype._dtraceStart = function _dtraceStart(req) {
    if (!req.dtrace) {
        return;
    }

    dtrace._rstfy_probes['route-start'].fire(function fire() {
        return [
            req.serverName,
            req.route.name,
            req._dtraceId,
            req.method,
            req.href(),
            req.headers
        ];
    });
};

/**
 * Setup request and calls _onRequest to run middlewares and call router
 *
 * @private
 * @memberof Router
 * @instance
 * @function _dtraceEnd
 * @param    {Request}    req - the request object
 * @param    {Response}    res - the response object
 * @returns  {undefined} no return value
 * @fires Request,Response#request
 */
Router.prototype._dtraceEnd = function _dtraceEnd(req, res) {
    if (!req.dtrace) {
        return;
    }

    dtrace._rstfy_probes['route-done'].fire(function fire() {
        return [
            req.serverName,
            req.route.name,
            req._dtraceId,
            res.statusCode || 200,
            res.headers()
        ];
    });
};

module.exports = Router;
