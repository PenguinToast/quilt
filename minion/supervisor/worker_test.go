package supervisor

import (
	"errors"
	"fmt"
	"net"
	"reflect"
	"testing"

	"github.com/davecgh/go-spew/spew"
	"github.com/quilt/quilt/db"
	"github.com/quilt/quilt/minion/ipdef"
	"github.com/stretchr/testify/assert"
	"github.com/vishvananda/netlink"
)

func TestWorker(t *testing.T) {
	ctx := initTest(db.Worker)
	ip := "1.2.3.4"
	etcdIPs := []string{ip}
	ctx.conn.Txn(db.AllTables...).Run(func(view db.Database) error {
		m := view.MinionSelf()
		e := view.SelectFromEtcd(nil)[0]
		m.Role = db.Worker
		m.PrivateIP = ip
		e.EtcdIPs = etcdIPs
		view.Commit(m)
		view.Commit(e)
		return nil
	})
	ctx.run()

	exp := map[string][]string{
		Etcd:        etcdArgsWorker(etcdIPs),
		Ovsdb:       {"ovsdb-server"},
		Ovsvswitchd: {"ovs-vswitchd"},
	}
	if !reflect.DeepEqual(ctx.fd.running(), exp) {
		t.Errorf("fd.running = %s\n\nwant %s", spew.Sdump(ctx.fd.running()),
			spew.Sdump(exp))
	}
	if len(ctx.execs) > 0 {
		t.Errorf("exec = %s; want <empty>", spew.Sdump(ctx.execs))
	}

	leaderIP := "5.6.7.8"
	ctx.conn.Txn(db.AllTables...).Run(func(view db.Database) error {
		m := view.MinionSelf()
		e := view.SelectFromEtcd(nil)[0]
		m.Role = db.Worker
		m.PrivateIP = ip
		e.EtcdIPs = etcdIPs
		e.LeaderIP = leaderIP
		view.Commit(m)
		view.Commit(e)
		return nil
	})
	ctx.run()

	exp = map[string][]string{
		Etcd:          etcdArgsWorker(etcdIPs),
		Ovsdb:         {"ovsdb-server"},
		Ovncontroller: {"ovn-controller"},
		Ovsvswitchd:   {"ovs-vswitchd"},
	}
	if !reflect.DeepEqual(ctx.fd.running(), exp) {
		t.Errorf("fd.running = %s\n\nwant %s", spew.Sdump(ctx.fd.running()),
			spew.Sdump(exp))
	}

	execExp := ovsExecArgs(ip, leaderIP)
	if !reflect.DeepEqual(ctx.execs, execExp) {
		t.Errorf("execs = %s\n\nwant %s", spew.Sdump(ctx.execs),
			spew.Sdump(execExp))
	}
}

func TestSetupWorker(t *testing.T) {
	ctx := initTest(db.Worker)

	setupWorker()

	exp := map[string][]string{
		Ovsdb:       {"ovsdb-server"},
		Ovsvswitchd: {"ovs-vswitchd"},
	}

	if !reflect.DeepEqual(ctx.fd.running(), exp) {
		t.Errorf("fd.running = %s\n\nwant %s", spew.Sdump(ctx.fd.running()),
			spew.Sdump(exp))
	}

	execExp := setupArgs()
	if !reflect.DeepEqual(ctx.execs, execExp) {
		t.Errorf("execs = %s\n\nwant %s", spew.Sdump(ctx.execs),
			spew.Sdump(execExp))
	}
}

func TestCfgGateway(t *testing.T) {
	linkByName = func(name string) (netlink.Link, error) {
		if name == "quilt-int" {
			return &netlink.Device{}, nil
		}
		return nil, errors.New("linkByName")
	}

	linkSetUp = func(link netlink.Link) error {
		return errors.New("linkSetUp")
	}

	addrAdd = func(link netlink.Link, addr *netlink.Addr) error {
		return errors.New("addrAdd")
	}

	ip := net.IPNet{IP: ipdef.GatewayIP, Mask: ipdef.QuiltSubnet.Mask}

	err := cfgGatewayImpl("bogus", ip)
	assert.EqualError(t, err, "no such interface: bogus (linkByName)")

	err = cfgGatewayImpl("quilt-int", ip)
	assert.EqualError(t, err, "failed to bring up link: quilt-int (linkSetUp)")

	var up bool
	linkSetUp = func(link netlink.Link) error {
		up = true
		return nil
	}

	up = false
	err = cfgGatewayImpl("quilt-int", ip)
	assert.EqualError(t, err, "failed to set address: quilt-int (addrAdd)")
	assert.True(t, up)

	var setAddr net.IPNet
	addrAdd = func(link netlink.Link, addr *netlink.Addr) error {
		setAddr = *addr.IPNet
		return nil
	}

	up = false
	err = cfgGatewayImpl("quilt-int", ip)
	assert.NoError(t, err)
	assert.True(t, up)
	assert.Equal(t, setAddr, ip)
}

func setupArgs() [][]string {
	vsctl := []string{
		"ovs-vsctl", "add-br", "quilt-int",
		"--", "set", "bridge", "quilt-int", "fail_mode=secure",
		"other_config:hwaddr=\"02:00:0a:00:00:01\"",
	}
	gateway := []string{"cfgGateway", "10.0.0.1/8"}
	return [][]string{vsctl, gateway}
}

func ovsExecArgs(ip, leader string) [][]string {
	vsctl := []string{"ovs-vsctl", "set", "Open_vSwitch", ".",
		fmt.Sprintf("external_ids:ovn-remote=\"tcp:%s:6640\"", leader),
		fmt.Sprintf("external_ids:ovn-encap-ip=%s", ip),
		"external_ids:ovn-encap-type=\"stt\"",
		fmt.Sprintf("external_ids:api_server=\"http://%s:9000\"", leader),
		fmt.Sprintf("external_ids:system-id=\"%s\"", ip),
	}
	return [][]string{vsctl}
}

func etcdArgsWorker(etcdIPs []string) []string {
	return []string{
		fmt.Sprintf("--initial-cluster=%s", initialClusterString(etcdIPs)),
		"--heartbeat-interval=500",
		"--election-timeout=5000",
		"--proxy=on",
	}
}
