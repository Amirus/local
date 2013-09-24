// Navigator
// =========

function getEnvironmentHost() {
	if (typeof window !== 'undefined') return window.location.host;
	if (app) return app.config.environmentHost; // must be passed to in the ready config
	return '';
}

// NavigatorContext
// ================
// INTERNAL
// information about the resource that a navigator targets
//  - exists in an "unresolved" state until the URI is confirmed by a response from the server
//  - enters a "bad" state if an attempt to resolve the link failed
//  - may be "relative" if described by a relation from another context (eg a query or a relative URI)
//  - may be "absolute" if described by an absolute URI
// :NOTE: absolute contexts may have a URI without being resolved, so don't take the presence of a URI as a sign that the resource exists
function NavigatorContext(query) {
	this.query = query;
	this.resolveState = NavigatorContext.UNRESOLVED;
	this.error = null;
	this.queryIsAbsolute = (typeof query == 'string' && local.web.isAbsUri(query));
	if (this.queryIsAbsolute) {
		this.url  = query;
		this.urld = local.web.parseUri(this.url);
	} else {
		this.url = null;
		this.urld = null;
	}
}
NavigatorContext.UNRESOLVED = 0;
NavigatorContext.RESOLVED   = 1;
NavigatorContext.FAILED     = 2;
NavigatorContext.prototype.isResolved = function() { return this.resolveState === NavigatorContext.RESOLVED; };
NavigatorContext.prototype.isBad      = function() { return this.resolveState === NavigatorContext.FAILED; };
NavigatorContext.prototype.isRelative = function() { return (!this.queryIsAbsolute); };
NavigatorContext.prototype.isAbsolute = function() { return this.queryIsAbsolute; };
NavigatorContext.prototype.getUrl     = function() { return this.url; };
NavigatorContext.prototype.getError   = function() { return this.error; };
NavigatorContext.prototype.resetResolvedState = function() {
	this.resolveState = NavigatorContext.UNRESOLVED;
	this.error = null;
};
NavigatorContext.prototype.setResolved = function(url) {
	this.error        = null;
	this.resolveState = NavigatorContext.RESOLVED;
	if (url) {
		this.url          = url;
		this.urld         = local.web.parseUri(this.url);
	}
};
NavigatorContext.prototype.setFailed = function(error) {
	this.error        = error;
	this.resolveState = NavigatorContext.FAILED;
};

// Navigator
// =========
// EXPORTED
// API to follow resource links (as specified by the response Link header)
//  - uses the rel attribute as the primary link label
//  - uses URI templates to generate URIs
//  - queues link navigations until a request is made
/*

// EXAMPLE 1. Get Bob from Foobar.com
// - basic navigation
// - requests
var foobarService = local.web.navigator('https://foobar.com');
var bob = foobarService.follow('|collection=users|item=bob');
// ^ or local.web.navigator('nav:||https://foobar.com|collection=users|item=bob')
// ^ or foobarService.follow([{ rel: 'collection', id: 'users' }, { rel: 'item', id:'bob' }]);
// ^ or foobarService.follow({ rel: 'collection', id: 'users' }).follow({ rel: 'item', id:'bob' });
bob.get()
	// -> HEAD https://foobar.com
	// -> HEAD https://foobar.com/users
	// -> GET  https://foobar.com/users/bob (Accept: application/json)
	.then(function(response) {
		var bobsProfile = response.body;

		// Update Bob's email
		bobsProfile.email = 'bob@gmail.com';
		bob.put(bobsProfile);
		// -> PUT https://foobar.com/users/bob { email:'bob@gmail.com', ...} (Content-Type: application/json)
	});

// EXAMPLE 2. Get all users who joined after 2013, in pages of 150
// - additional navigation query parameters
// - server-driven batching
var pageCursor = foobarService.follow('|collection=users,since=2013-01-01,limit=150');
pageCursor.get()
	// -> GET https://foobar.com/users?since=2013-01-01&limit=150 (Accept: application/json)
	.then(function readNextPage(response) {
		// Send the emails
		emailNewbieGreetings(response.body); // -- emailNewbieGreetings is a fake utility function

		// Go to the 'next page' link, as supplied by the response
		pageCursor = pageCursor.follow('|next');
		return pageCursor.get().then(readNextPage);
		// -> GET https://foobar.com/users?since=2013-01-01&limit=150&offset=150 (Accept: application/json)
	})
	.fail(function(response, request) {
		// Not finding a 'rel=next' link means the server didn't give us one.
		if (response.status == local.web.LINK_NOT_FOUND) { // 001 Local: Link not found - termination condition
			// Tell Bob his greeting was sent
			bob.follow('|grimwire.com/-mail/inbox').post({
				title: '2013 Welcome Emails Sent',
				body: 'Good work, Bob.'
			});
			// -> POST https://foobar.com/mail/users/bob/inbox (Content-Type: application/json)
		} else {
			// Tell Bob something went wrong
			bob.follow('|grimwire.com/-mail/inbox').post({
				title: 'ERROR! 2013 Welcome Emails Failed!',
				body: 'Way to blow it, Bob.',
				attachments: {
					'dump.json': {
						context: pageCursor.getContext(),
						request: request,
						response: response
					}
				}
			});
			// -> POST https://foobar.com/mail/users/bob/inbox (Content-Type: application/json)
		}
	});
*/
function Navigator(context, parentNavigator) {
	this.context         = context         || null;
	this.parentNavigator = parentNavigator || null;
	this.links           = null;
	this.requestDefaults = null;

	if (this.context.isRelative() && !parentNavigator)
		throw new Error("A parentNavigator is required for navigators with relative contexts");
}
local.web.Navigator = Navigator;

// Sets defaults to be used in all requests
// - eg nav.setRequestDefaults({ method: 'GET', headers: { authorization: 'bob:pass', accept: 'text/html' }})
// - eg nav.setRequestDefaults({ proxy: 'httpl://myproxy.app' })
Navigator.prototype.setRequestDefaults = function(v) {
	this.requestDefaults = v;
};

// Helper to copy over request defaults
function copyDefaults(target, defaults) {
	for (var k in defaults) {
		if (k == 'headers' || !!target[k])
			continue;
		// ^ headers should be copied per-attribute
		if (typeof defaults[k] == 'object')
			target[k] = local.util.deepClone(defaults[k]);
		else
			target[k] = defaults[k];
	}
	if (defaults.headers) {
		if (!target.headers)
			target.headers = {};
		copyDefaults(target.headers, defaults.headers);
	}
}

// Executes an HTTP request to our context
//  - uses additional parameters on the request options:
//    - retry: bool, should the url resolve be tried if it previously failed?
Navigator.prototype.dispatch = function(req) {
	if (!req) req = {};
	if (!req.headers) req.headers = {};
	var self = this;

	if (this.requestDefaults)
		copyDefaults(req, this.requestDefaults);

	// Resolve our target URL
	return ((req.url) ? local.promise(req.url) : this.resolve({ retry: req.retry, nohead: true }))
		.succeed(function(url) {
			req.url = url;
			return local.web.dispatch(req);
		})
		.succeed(function(res) {
			// After every successful request, update our links and mark our context as good (in case it had been bad)
			self.context.setResolved();
			if (res.headers.link) self.links = res.headers.link;
			else self.links = self.links || []; // cache an empty link list so we dont keep trying during resolution
			return res;
		})
		.fail(function(res) {
			// Let a 1 or 404 indicate a bad context (as opposed to some non-navigational error like a bad request body)
			if (res.status === local.web.LINK_NOT_FOUND || res.status === 404)
				self.context.setFailed(res);
			throw res;
		});
};

// Executes a GET text/event-stream request to our context
Navigator.prototype.subscribe = function(req) {
	var self = this;
	if (!req) req = {};
	return this.resolve({ nohead: true }).succeed(function(url) {
		req.url = url;

		if (self.requestDefaults)
			copyDefaults(req, self.requestDefaults);

		return local.web.subscribe(req);
	});
};

// Follows a link relation from our context, generating a new navigator
// - `query` may be:
//   - an object in the same form of a `local.web.queryLink()` parameter
//   - an array of link query objects (to be followed sequentially)
//   - a URI string
//     - if using the 'nav:' scheme, will convert the URI into a link query object
//     - if a relative URI using the HTTP/S/L scheme, will follow the relation relative to the current context
//     - if an absolute URI using the HTTP/S/L scheme, will go to that URI
// - uses URI Templates to generate URLs
// - when querying, only the `rel` and `id` (if specified) attributes must match
//   - the exception to this is: `rel` matches and the HREF has an {id} token
//   - all other attributes are used to fill URI Template tokens and are not required to match
Navigator.prototype.follow = function(query) {
	// convert nav: uri to a query array
	if (typeof query == 'string' && local.web.isNavSchemeUri(query))
		query = local.web.parseNavUri(query);

	// make sure we always have an array
	if (!Array.isArray(query))
		query = [query];

	// build a full follow() chain
	var nav = this;
	do {
		nav = new Navigator(new NavigatorContext(query.shift()), nav);
		if (this.requestDefaults)
			nav.setRequestDefaults(this.requestDefaults);
	} while (query[0]);

	return nav;
};

// Resets the navigator's resolution state, causing it to reissue HEAD requests (relative to any parent navigators)
Navigator.prototype.unresolve = function() {
	this.context.resetResolvedState();
	this.links = null;
	return this;
};

// Reassigns the navigator to a new absolute URL
// - `url`: required string, the URL to rebase the navigator to
// - resets the resolved state
Navigator.prototype.rebase = function(url) {
	this.unresolve();
	this.context.query = url;
	this.context.queryIsAbsolute = true;
	this.context.url  = url;
	this.context.urld = local.web.parseUri(url);
	return this;
};

// Resolves the navigator's URL, reporting failure if a link or resource is unfound
//  - also ensures the links have been retrieved from the context
//  - may trigger resolution of parent contexts
//  - options is optional and may include:
//    - retry: bool, should the resolve be tried if it previously failed?
//    - nohead: bool, should we issue a HEAD request once we have a URL? (not favorable if planning to dispatch something else)
//  - returns a promise which will fulfill with the resolved url
Navigator.prototype.resolve = function(options) {
	var self = this;
	options = options || {};

	var nohead = options.nohead;
	delete options.nohead;
	// ^ pull `nohead` out so that parent resolves are `nohead: false` - we do want them to dispatch HEAD requests to resolve us

	var resolvePromise = local.promise();
	if (this.links !== null && (this.context.isResolved() || (this.context.isAbsolute() && this.context.isBad() === false))) {
		// We have links and we were previously resolved (or we're absolute so there's no need)
		resolvePromise.fulfill(this.context.getUrl());
	} else if (this.context.isBad() === false || (this.context.isBad() && options.retry)) {
		// We don't have links, and we haven't previously failed (or we want to try again)
		this.context.resetResolvedState();

		if (this.context.isRelative()) {
			if (!this.parentNavigator)
				throw new Error("Relative navigator has no parent");

			// Up the chain we go
			resolvePromise = this.parentNavigator.resolve(options)
				.succeed(function() {
					// Parent resolved, query its links
					var childUrl = self.parentNavigator.lookupLink(self.context);
					if (childUrl) {
						// We have a pope! I mean, link.
						self.context.setResolved(childUrl);

						// Send a HEAD request to get our links
						if (nohead) // unless dont
							return childUrl;
						return self.dispatch({ method: 'HEAD', url: childUrl })
							.succeed(function() { return childUrl; }); // fulfill resolvePromise afterward
					}

					// Error - Link not found
					var response = new local.web.Response();
					response.writeHead(local.web.LINK_NOT_FOUND, 'link query failed to match').end();
					throw response;
				})
				.fail(function(error) {
					self.context.setFailed(error);
					throw error;
				});
		} else {
			// At the top of the chain already
			if (nohead)
				resolvePromise.fulfill(self.context.getUrl());
			else {
				resolvePromise = this.dispatch({ method: 'HEAD', url: self.context.getUrl() })
					.succeed(function(res) { return self.context.getUrl(); });
			}
		}
	} else {
		// We failed in the past and we don't want to try again
		resolvePromise.reject(this.context.getError());
	}
	return resolvePromise;
};

// Looks up a link in the cache and generates the URI (the follow logic)
Navigator.prototype.lookupLink = function(context) {
	if (context.query) {
		if (typeof context.query == 'object') {

			// Try to find a link that matches
			var link = local.web.queryLinks1(this.links, context.query);
			if (link)
				return local.web.UriTemplate.parse(link.href).expand(context.query);
		}
		else if (typeof context.query == 'string') {
			// A URL
			if (!local.web.isAbsUrl(context.query))
				return local.web.joinRelPath(this.context.urld, context.query);
			return context.query;
		}
	}
	console.log('Failed to find a link to resolve context. Link query:', context.query, 'Navigator:', this);
	return null;
};

// Dispatch Sugars
// ===============
function makeDispSugar(method) {
	return function(headers, options) {
		var req = options || {};
		req.headers = headers || {};
		req.method = method;
		return this.dispatch(req);
	};
}
function makeDispWBodySugar(method) {
	return function(body, headers, options) {
		var req = options || {};
		req.headers = headers || {};
		req.method = method;
		req.body = body;
		return this.dispatch(req);
	};
}
Navigator.prototype.head   = makeDispSugar('HEAD');
Navigator.prototype.get    = makeDispSugar('GET');
Navigator.prototype.delete = makeDispSugar('DELETE');
Navigator.prototype.post   = makeDispWBodySugar('POST');
Navigator.prototype.put    = makeDispWBodySugar('PUT');
Navigator.prototype.patch  = makeDispWBodySugar('PATCH');
Navigator.prototype.notify = makeDispWBodySugar('NOTIFY');

// Builder
// =======
local.web.navigator = function(queryOrNav) {
	if (queryOrNav instanceof Navigator)
		return queryOrNav;

	// convert nav: uri to a query array
	if (typeof queryOrNav == 'string' && local.web.isNavSchemeUri(queryOrNav))
		queryOrNav = local.web.parseNavUri(queryOrNav);

	// make sure we always have an array
	if (!Array.isArray(queryOrNav))
		queryOrNav = [queryOrNav];

	// build a full follow() chain
	var nav = new Navigator(new NavigatorContext(queryOrNav.shift()));
	while (queryOrNav[0]) {
		nav = new Navigator(new NavigatorContext(queryOrNav.shift()), nav);
	}

	return nav;
};