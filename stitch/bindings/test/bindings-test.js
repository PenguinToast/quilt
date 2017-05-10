const chai = require('chai');
const chaiSubset = require('chai-subset');
const {
    Assertion,
    Connection,
    Container,
    Deployment,
    Image,
    LabelRule,
    Machine,
    MachineRule,
    Port,
    PortRange,
    Range,
    Service,
    between,
    boxRange,
    createDeployment,
    enough,
    githubKeys,
    invariantType,
    neighbor,
    publicInternet,
    reachable,
    reachableACL,
    read,
    resetGlobals,
} = require('../../bindings.js');

chai.use(chaiSubset);
const { expect } = chai;

describe('Bindings', function () {
    let deployment;
    beforeEach(function () {
        resetGlobals();
        deployment = createDeployment();
    });

    describe('Machine', function () {
        const checkMachines = function (expected) {
            const { machines } = deployment.toQuiltRepresentation();
            expect(machines).to.have.lengthOf(expected.length)
                .and.containSubset(expected);
        };
        it('basic', function () {
            deployment.deploy([new Machine({
                role: 'Worker',
                provider: 'Amazon',
                region: 'us-west-2',
                size: 'm4.large',
                cpu: new Range(2, 4),
                ram: new Range(4, 8),
                diskSize: 32,
                sshKeys: ['key1', 'key2'],
            })]);
            checkMachines([{
                id: '93e93257df71a41050032714b35b20736994c713',
                role: 'Worker',
                provider: 'Amazon',
                region: 'us-west-2',
                size: 'm4.large',
                cpu: new Range(2, 4),
                ram: new Range(4, 8),
                diskSize: 32,
                sshKeys: ['key1', 'key2'],
            }]);
        });
        it('hash independent of SSH keys', function () {
            deployment.deploy([new Machine({
                role: 'Worker',
                provider: 'Amazon',
                region: 'us-west-2',
                size: 'm4.large',
                cpu: new Range(2, 4),
                ram: new Range(4, 8),
                diskSize: 32,
                sshKeys: ['key3'],
            })]);
            checkMachines([{
                id: '93e93257df71a41050032714b35b20736994c713',
                role: 'Worker',
                provider: 'Amazon',
                region: 'us-west-2',
                size: 'm4.large',
                cpu: new Range(2, 4),
                ram: new Range(4, 8),
                diskSize: 32,
                sshKeys: ['key3'],
            }]);
        });
        it('replicate', function () {
            const baseMachine = new Machine({ provider: 'Amazon' });
            deployment.deploy(baseMachine.asMaster().replicate(2));
            checkMachines([
                {
                    id: '404c03a697ed922c6108db21ce2cd1ad5d212d96',
                    role: 'Master',
                    provider: 'Amazon',
                    sshKeys: [],
                },
                {
                    id: '52577e8362c035260bcab31e3700c8718a345053',
                    role: 'Master',
                    provider: 'Amazon',
                    sshKeys: [],
                },
            ]);
        });
        it('replicate independent', function () {
            const baseMachine = new Machine({ provider: 'Amazon' });
            const machines = baseMachine.asMaster().replicate(2);
            machines[0].sshKeys.push('key');
            deployment.deploy(machines);
            checkMachines([
                {
                    id: '404c03a697ed922c6108db21ce2cd1ad5d212d96',
                    role: 'Master',
                    provider: 'Amazon',
                    sshKeys: ['key'],
                },
                {
                    id: '52577e8362c035260bcab31e3700c8718a345053',
                    role: 'Master',
                    provider: 'Amazon',
                    sshKeys: [],
                },
            ]);
        });
        it('set floating IP', function () {
            const baseMachine = new Machine({
                provider: 'Amazon',
                floatingIp: 'xxx.xxx.xxx.xxx',
            });
            deployment.deploy(baseMachine.asMaster());
            checkMachines([{
                id: 'a905d3dffcf2587b6ad785055064ca4a0a1fa2e8',
                role: 'Master',
                provider: 'Amazon',
                floatingIp: 'xxx.xxx.xxx.xxx',
                sshKeys: [],
            }]);
        });
    });

    describe('Container', function () {
        const checkContainers = function (expected) {
            const { containers } = deployment.toQuiltRepresentation();
            expect(containers).to.have.lengthOf(expected.length)
                .and.containSubset(expected);
        };
        it('basic', function () {
            deployment.deploy(new Service('foo', [
                new Container('image'),
            ]));
            checkContainers([{
                id: '475c40d6070969839ba0f88f7a9bd0cc7936aa30',
                image: new Image('image'),
                command: [],
                env: {},
                filepathToContent: {},
            }]);
        });
        it('command', function () {
            deployment.deploy(new Service('foo', [
                new Container('image', ['arg1', 'arg2']),
            ]));
            checkContainers([{
                id: '45b5015830c4b8fb738d15c7a2822ee108c20bd8',
                image: new Image('image'),
                command: ['arg1', 'arg2'],
                env: {},
                filepathToContent: {},
            }]);
        });
        it('env', function () {
            const c = new Container('image');
            c.env.foo = 'bar';
            deployment.deploy(new Service('foo', [c]));
            checkContainers([{
                id: 'f54486d0f95b4cc478952a1a775a0699d8f5d959',
                image: new Image('image'),
                command: [],
                env: { foo: 'bar' },
                filepathToContent: {},
            }]);
        });
        it('command, env, and files', function () {
            deployment.deploy(new Service('foo', [
                new Container('image', ['arg1', 'arg2'])
                    .withEnv({ foo: 'bar' })
                    .withFiles({ qux: 'quuz' }),
            ]));
            checkContainers([{
                id: '3f0028780b8d9e35ae8c02e4e8b87e2ca55305db',
                image: new Image('image'),
                command: ['arg1', 'arg2'],
                env: { foo: 'bar' },
                filepathToContent: { qux: 'quuz' },
            }]);
        });
        it('image dockerfile', function () {
            const c = new Container(new Image('name', 'dockerfile'));
            deployment.deploy(new Service('foo', [c]));
            checkContainers([{
                id: '1dc23744f60b5c2fb7e3eafb3e8a7e3b085b9b9c',
                image: new Image('name', 'dockerfile'),
                command: [],
                env: {},
                filepathToContent: {},
            }]);
        });
        it('replicate', function () {
            deployment.deploy(new Service('foo', new Container('image', ['arg'])
                .replicate(2)));
            checkContainers([
                {
                    id: '6563036090dd1a6d4a2fe2f56a31e61c2cdca8e2',
                    image: new Image('image'),
                    command: ['arg'],
                    env: {},
                    filepathToContent: {},
                },
                {
                    id: 'c6cea5bd411c6e5afac755c37517af89a2d03dbe',
                    image: new Image('image'),
                    command: ['arg'],
                    env: {},
                    filepathToContent: {},
                },
            ]);
        });
        it('replicate independent', function () {
            const repl = new Container('image', ['arg']).replicate(2);
            repl[0].env.foo = 'bar';
            repl[0].command.push('changed');
            deployment.deploy(new Service('baz', repl));
            checkContainers([
                {
                    id: '6563036090dd1a6d4a2fe2f56a31e61c2cdca8e2',
                    image: new Image('image'),
                    command: ['arg'],
                    env: {},
                    filepathToContent: {},
                },
                {
                    id: 'c3371b4dec2600f20cd8cc5b59bc116dedcbea92',
                    image: new Image('image'),
                    command: ['arg', 'changed'],
                    env: { foo: 'bar' },
                    filepathToContent: {},
                },
            ]);
        });
        it('hostname', function () {
            const c = new Container(new Image('image'));
            c.setHostname('host');
            deployment.deploy(new Service('foo', [c]));
            checkContainers([{
                id: '475c40d6070969839ba0f88f7a9bd0cc7936aa30',
                image: new Image('image'),
                command: [],
                env: {},
                filepathToContent: {},
                hostname: 'host',
            }]);
        });
        it('#getHostname()', function () {
            const c = new Container('image');
            c.setHostname('host');
            expect(c.getHostname()).to.equal('host.q');
        });
        it('duplicate hostname', function () {
            const a = new Container('image');
            a.setHostname('host');
            const b = new Container('image');
            b.setHostname('host');
            deployment.deploy(new Service('foo', [a, b]));
            expect(() => deployment.toQuiltRepresentation()).to
                .throw('hostname "host" used for multiple containers');
        });
    });

    describe('Placement', function () {
        let target;
        let other;
        const checkPlacements = function (expected) {
            deployment.deploy(target);
            deployment.deploy(other);
            const { placements } = deployment.toQuiltRepresentation();
            expect(placements).to.have.lengthOf(expected.length)
                .and.containSubset(expected);
        };
        beforeEach(function () {
            target = new Service('target', []);
            other = new Service('other', []);
        });
        it('LabelRule', function () {
            target.place(new LabelRule(true, other));
            checkPlacements([{
                targetLabel: 'target',
                otherLabel: 'other',
                exclusive: true,
            }]);
        });
        it('MachineRule size, region, provider', function () {
            target.place(new MachineRule(true, {
                size: 'm4.large',
                region: 'us-west-2',
                provider: 'Amazon',
            }));
            checkPlacements([{
                targetLabel: 'target',
                exclusive: true,
                region: 'us-west-2',
                provider: 'Amazon',
                size: 'm4.large',
            }]);
        });
        it('MachineRule size, provider', function () {
            target.place(new MachineRule(true, {
                size: 'm4.large',
                provider: 'Amazon',
            }));
            checkPlacements([{
                targetLabel: 'target',
                exclusive: true,
                provider: 'Amazon',
                size: 'm4.large',
            }]);
        });
        it('MachineRule floatingIp', function () {
            target.place(new MachineRule(false, {
                floatingIp: 'xxx.xxx.xxx.xxx',
            }));
            checkPlacements([{
                targetLabel: 'target',
                exclusive: false,
                floatingIp: 'xxx.xxx.xxx.xxx',
            }]);
        });
    });
    describe('Label', function () {
        const checkLabels = function (expected) {
            const { labels } = deployment.toQuiltRepresentation();
            expect(labels).to.have.lengthOf(expected.length)
                .and.containSubset(expected);
        };
        it('basic', function () {
            deployment.deploy(new Service('web_tier', [new Container('nginx')]));
            checkLabels([{
                name: 'web_tier',
                ids: ['c47b5770b59a4459519ba2b3ae3cd7a1598fbd8d'],
                annotations: [],
            }]);
        });
        it('multiple containers', function () {
            deployment.deploy(new Service('web_tier', [
                new Container('nginx'),
                new Container('nginx'),
            ]));
            checkLabels([{
                name: 'web_tier',
                ids: [
                    'c47b5770b59a4459519ba2b3ae3cd7a1598fbd8d',
                    '6044e40ba6e4d97be45ca290b993ef2f368c7bb1',
                ],
                annotations: [],
            }]);
        });
        it('duplicate services', function () {
            /* Conflicting label names.  We need to generate a couple of dummy containers
               so that the two deployed containers have _refID's that are sorted
               differently lexicographically and numerically. */
            for (let i = 0; i < 2; i += 1) {
                Container('image');
            }
            deployment.deploy(new Service('foo', [new Container('image')]));
            for (let i = 0; i < 7; i += 1) {
                Container('image');
            }
            deployment.deploy(new Service('foo', [new Container('image')]));
            checkLabels([
                {
                    name: 'foo',
                    ids: ['475c40d6070969839ba0f88f7a9bd0cc7936aa30'],
                    annotations: [],
                },
                {
                    name: 'foo2',
                    ids: ['3047630375a1621cb400811b795757a07de8e268'],
                    annotations: [],
                },
            ]);
        });
        it('get service hostname', function () {
            const foo = new Service('foo', []);
            expect(foo.hostname()).to.equal('foo.q');
        });
        it('get service children', function () {
            const foo = new Service('foo', [
                new Container('bar'),
                new Container('baz'),
            ]);
            expect(foo.children()).to.eql(['1.foo.q', '2.foo.q']);
        });
    });
    describe('Connect', function () {
        let foo;
        let bar;
        beforeEach(function () {
            foo = new Service('foo', []);
            bar = new Service('bar', []);
            deployment.deploy([foo, bar]);
        });
        const checkConnections = function (expected) {
            const { connections } = deployment.toQuiltRepresentation();
            expect(connections).to.have.lengthOf(expected.length)
                .and.containSubset(expected);
        };
        it('port', function () {
            foo.connect(new Port(80), bar);
            checkConnections([{
                from: 'foo',
                to: 'bar',
                minPort: 80,
                maxPort: 80,
            }]);
        });
        it('port range', function () {
            foo.connect(new PortRange(80, 85), bar);
            checkConnections([{
                from: 'foo',
                to: 'bar',
                minPort: 80,
                maxPort: 85,
            }]);
        });
        it('connect to publicInternet', function () {
            foo.connect(80, publicInternet);
            checkConnections([{
                from: 'foo',
                to: 'public',
                minPort: 80,
                maxPort: 80,
            }]);
        });
        it('connect from publicInternet', function () {
            publicInternet.connect(80, foo);
            checkConnections([{
                from: 'public',
                to: 'foo',
                minPort: 80,
                maxPort: 80,
            }]);
        });
        it('connect to publicInternet port range', function () {
            expect(() => foo.connect(new PortRange(80, 81), publicInternet)).to
                .throw('public internet cannot connect on port ranges');
        });
        it('connect from publicInternet port range', function () {
            expect(() => publicInternet.connect(new PortRange(80, 81), foo)).to
                .throw('public internet cannot connect on port ranges');
        });
    });
    describe('Vet', function () {
        let foo;
        const deploy = () => deployment.toQuiltRepresentation();
        beforeEach(function () {
            foo = new Service('foo', []);
            deployment.deploy([foo]);
        });
        it('connect to undeployed label', function () {
            foo.connect(80, new Service('baz', []));
            expect(deploy).to.throw('foo has a connection to undeployed service: baz');
        });
        it('placement in terms of undeployed label', function () {
            foo.place(new MachineRule(false, { provider: 'Amazon' }));
            foo.place(new LabelRule(true, new Service('baz', [])));
            expect(deploy).to
                .throw('foo has a placement in terms of an undeployed service: baz');
        });
        it('floating IP and multiple containers', function () {
            foo = new Service('foo', new Container('image').replicate(2));
            foo.place(new MachineRule(false, {
                floatingIp: '123',
            }));
            foo.connectFromPublic(80);
            deployment.deploy([foo]);
            expect(deploy).to.throw(
                'foo2 has a floating IP and multiple containers. This is not yet supported.');
        });
        it('duplicate image', function () {
            deployment.deploy(new Service('foo', [new Container(new Image('img', 'dk'))]));
            deployment.deploy(new Service('foo', [new Container(new Image('img', 'dk'))]));
            expect(deploy).to.not.throw();
        });
        it('duplicate image with different Dockerfiles', function () {
            deployment.deploy(new Service('foo', [new Container(new Image('img', 'dk'))]));
            deployment.deploy(new Service('foo', [new Container(new Image('img', 'dk2'))]));
            expect(deploy).to.throw('img has differing Dockerfiles');
        });
    });
    describe('Custom Deploy', function () {
        it('basic', function () {
            deployment.deploy({
                deploy(dep) {
                    dep.deploy([
                        new Service('web_tier', [new Container('nginx')]),
                        new Service('web_tier2', [new Container('nginx')]),
                    ]);
                },
            });
            const { labels } = deployment.toQuiltRepresentation();
            expect(labels).to.have.lengthOf(2)
                .and.containSubset([
                    {
                        name: 'web_tier',
                        ids: ['c47b5770b59a4459519ba2b3ae3cd7a1598fbd8d'],
                        annotations: [],
                    },
                    {
                        name: 'web_tier2',
                        ids: ['6044e40ba6e4d97be45ca290b993ef2f368c7bb1'],
                        annotations: [],
                    },
                ]);
        });
        it('missing deploy', function () {
            expect(() => deployment.deploy({})).to.throw(
                'only objects that implement "deploy(deployment)" can be deployed');
        });
    });
    describe('Create Deployment', function () {
        it('no args', function () {
            expect(createDeployment).to.not.throw();
        });
    });
    describe('Query', function () {
        it('namespace', function () {
            deployment = createDeployment({ namespace: 'myNamespace' });
            expect(deployment.toQuiltRepresentation().namespace).to.equal('myNamespace');
        });
        it('default namespace', function () {
            expect(deployment.toQuiltRepresentation().namespace).to.equal('default-namespace');
        });
        it('max price', function () {
            deployment = createDeployment({ maxPrice: 5 });
            expect(deployment.toQuiltRepresentation().maxPrice).to.equal(5);
        });
        it('default max price', function () {
            expect(deployment.toQuiltRepresentation().maxPrice).to.equal(0);
        });
        it('admin ACL', function () {
            deployment = createDeployment({ adminACL: ['local'] });
            expect(deployment.toQuiltRepresentation().adminACL).to.eql(['local']);
        });
        it('default admin ACL', function () {
            expect(deployment.toQuiltRepresentation().adminACL).to.eql([]);
        });
    });
    describe('hash()', function () {});
    describe('read()', function () {});
    describe('githubKeys()', function () {});
});
