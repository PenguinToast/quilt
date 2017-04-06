//go:generate ../scripts/generate-bindings bindings.js

package stitch

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
)

// A Stitch is an abstract representation of the policy language.
type Stitch struct {
	Containers  []Container  `json:",omitempty"`
	Labels      []Label      `json:",omitempty"`
	Connections []Connection `json:",omitempty"`
	Placements  []Placement  `json:",omitempty"`
	Machines    []Machine    `json:",omitempty"`

	AdminACL  []string `json:",omitempty"`
	MaxPrice  float64  `json:",omitempty"`
	Namespace string   `json:",omitempty"`

	Invariants []invariant `json:",omitempty"`
}

// A Placement constraint guides where containers may be scheduled, either relative to
// the labels of other containers, or the machine the container will run on.
type Placement struct {
	TargetLabel string `json:",omitempty"`

	Exclusive bool `json:",omitempty"`

	// Label Constraint
	OtherLabel string `json:",omitempty"`

	// Machine Constraints
	Provider   string `json:",omitempty"`
	Size       string `json:",omitempty"`
	Region     string `json:",omitempty"`
	FloatingIP string `json:",omitempty"`
}

// An Image represents a Docker image that can be run. If the Dockerfile is non-empty,
// the image should be built and hosted by Quilt.
type Image struct {
	Name       string `json:",omitempty"`
	Dockerfile string `json:",omitempty"`
}

// A Container may be instantiated in the stitch and queried by users.
type Container struct {
	ID                string            `json:",omitempty"`
	Image             Image             `json:",omitempty"`
	Command           []string          `json:",omitempty"`
	Env               map[string]string `json:",omitempty"`
	FilepathToContent map[string]string `json:",omitempty"`
	Hostname          string            `json:",omitempty"`
}

// A Label represents a logical group of containers.
type Label struct {
	Name        string   `json:",omitempty"`
	IDs         []string `json:",omitempty"`
	Annotations []string `json:",omitempty"`
}

// A Connection allows containers implementing the From label to speak to containers
// implementing the To label in ports in the range [MinPort, MaxPort]
type Connection struct {
	From    string `json:",omitempty"`
	To      string `json:",omitempty"`
	MinPort int    `json:",omitempty"`
	MaxPort int    `json:",omitempty"`
}

// A ConnectionSlice allows for slices of Collections to be used in joins
type ConnectionSlice []Connection

// A Machine specifies the type of VM that should be booted.
type Machine struct {
	ID         string   `json:",omitempty"`
	Provider   string   `json:",omitempty"`
	Role       string   `json:",omitempty"`
	Size       string   `json:",omitempty"`
	CPU        Range    `json:",omitempty"`
	RAM        Range    `json:",omitempty"`
	DiskSize   int      `json:",omitempty"`
	Region     string   `json:",omitempty"`
	SSHKeys    []string `json:",omitempty"`
	FloatingIP string   `json:",omitempty"`
}

// A Range defines a range of acceptable values for a Machine attribute
type Range struct {
	Min float64 `json:",omitempty"`
	Max float64 `json:",omitempty"`
}

// PublicInternetLabel is a magic label that allows connections to or from the public
// network.
const PublicInternetLabel = "public"

// Accepts returns true if `x` is within the range specified by `stitchr` (include),
// or if no max is specified and `x` is larger than `stitchr.min`.
func (stitchr Range) Accepts(x float64) bool {
	return stitchr.Min <= x && (stitchr.Max == 0 || x <= stitchr.Max)
}

// `run` evaluates `javascript` in Node.js and returns the output.
func run(javascript string) ([]byte, error) {
	cmd := exec.Command("node", "-p", javascript)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	out, err := cmd.Output()
	if err != nil {
		return []byte{}, errors.New(stderr.String())
	}
	return out, nil
}

// TODO: This function will become unnecessary when we move all Stitch unit tests
// to Node.js. Then we can clean up the functions around this.
func runJavascript(javascript string) ([]byte, error) {
	return run(`const {
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
    deployment,
    getDeployment,
    enough,
    githubKeys,
    invariantType,
    neighbor,
    publicInternet,
    reachable,
    reachableACL,
    read,
} = require('./bindings.js');
try {` +
		javascript +
		`;
} catch (e) {
    process.stderr.write(e);
    process.exit(1);
}`)
}

// TODO: Better name.
func fromBytes(bytes []byte) (stc Stitch, err error) {
	err = json.Unmarshal(bytes, &stc)
	if err != nil {
		return Stitch{}, err
	}
	stc.createPortRules()

	if len(stc.Invariants) == 0 {
		return stc, nil
	}

	graph, err := InitializeGraph(stc)
	if err != nil {
		return Stitch{}, err
	}

	if err := checkInvariants(graph, stc.Invariants); err != nil {
		return Stitch{}, err
	}

	return stc, nil
}

// FromJavascript gets a Stitch handle from a string containing Javascript code.
func FromJavascript(specStr string) (Stitch, error) {
	out, err := runJavascript(specStr +
		";JSON.stringify(getDeployment().toQuiltRepresentation());")
	if err != nil {
		return Stitch{}, err
	}
	return fromBytes(out)
}

// FromFile gets a Stitch handle from a file on disk.
func FromFile(filename string) (Stitch, error) {
	// Change working directory to load the correct Deployment instance.
	wd, err := os.Getwd()
	if err != nil {
		return Stitch{}, err
	}
	err = os.Chdir(filepath.Dir(filename))
	if err != nil {
		return Stitch{}, err
	}

	out, err := run("const { getDeployment } = require('@quilt/core');" +
		"require('./" + filename + "');" +
		"JSON.stringify(getDeployment().toQuiltRepresentation());")
	if err != nil {
		return Stitch{}, err
	}
	stc, err := fromBytes(out)
	if err != nil {
		return Stitch{}, err
	}

	// Restore original working directory.
	err = os.Chdir(wd)
	if err != nil {
		return Stitch{}, err
	}
	return stc, nil
}

// FromJSON gets a Stitch handle from the deployment representation.
func FromJSON(jsonStr string) (stc Stitch, err error) {
	err = json.Unmarshal([]byte(jsonStr), &stc)
	return stc, err
}

// createPortRules creates exclusive placement rules such that no two containers
// listening on the same public port get placed on the same machine.
func (stitch *Stitch) createPortRules() {
	ports := make(map[int][]string)
	for _, c := range stitch.Connections {
		if c.From != PublicInternetLabel {
			continue
		}

		min := c.MinPort
		ports[min] = append(ports[min], c.To)
	}

	for _, labels := range ports {
		for _, tgt := range labels {
			for _, other := range labels {
				stitch.Placements = append(stitch.Placements,
					Placement{
						Exclusive:   true,
						TargetLabel: tgt,
						OtherLabel:  other,
					})
			}
		}
	}
}

// String returns the Stitch in its deployment representation.
func (stitch Stitch) String() string {
	jsonBytes, err := json.Marshal(stitch)
	if err != nil {
		panic(err)
	}
	return string(jsonBytes)
}

// Get returns the value contained at the given index
func (cs ConnectionSlice) Get(ii int) interface{} {
	return cs[ii]
}

// Len returns the number of items in the slice
func (cs ConnectionSlice) Len() int {
	return len(cs)
}
