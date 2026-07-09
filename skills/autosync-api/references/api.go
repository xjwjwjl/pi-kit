// api.go — 放置于 {server}/utils/autosync/ 目录下。
// 提供 AutoApiGroup + Flush，消除 Gin 路由与 Casbin sys_apis 的 Method/Path 重复声明。
package autosync

import (
	"your-project/model/sys"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

// ── API 同步 ──────────────────────────────────────────────────────────────

type Route struct {
	Method   string
	Path     string
	Desc     string
	ApiGroup string
}

var globalRoutes []*Route

type AutoApiGroup struct {
	*gin.RouterGroup
	basePath     string
	currentGroup string
}

func NewAutoApiGroup(group *gin.RouterGroup, basePath string) *AutoApiGroup {
	return &AutoApiGroup{RouterGroup: group, basePath: basePath}
}

func (g *AutoApiGroup) SetApiGroup(s string) *AutoApiGroup {
	g.currentGroup = s
	return g
}

func (g *AutoApiGroup) register(method, path string, handler gin.HandlerFunc) *Route {
	r := &Route{Method: method, Path: g.basePath + path, ApiGroup: g.currentGroup}
	globalRoutes = append(globalRoutes, r)
	switch method {
	case "POST":
		g.RouterGroup.POST(path, handler)
	case "GET":
		g.RouterGroup.GET(path, handler)
	case "PUT":
		g.RouterGroup.PUT(path, handler)
	case "DELETE":
		g.RouterGroup.DELETE(path, handler)
	}
	return r
}

func (g *AutoApiGroup) POST(path string, h gin.HandlerFunc) *Route   { return g.register("POST", path, h) }
func (g *AutoApiGroup) GET(path string, h gin.HandlerFunc) *Route    { return g.register("GET", path, h) }
func (g *AutoApiGroup) PUT(path string, h gin.HandlerFunc) *Route    { return g.register("PUT", path, h) }
func (g *AutoApiGroup) DELETE(path string, h gin.HandlerFunc) *Route { return g.register("DELETE", path, h) }
func (r *Route) SetDesc(s string) *Route { r.Desc = s; return r }

// Flush 查询已有路由 → 过滤去重 → CreateInBatches 批量写入 sys_apis。
func Flush(db *gorm.DB) {
	if len(globalRoutes) == 0 {
		return
	}
	type key struct {
		Path   string
		Method string
	}
	existing := make(map[key]struct{})
	var rows []struct {
		Path   string
		Method string
	}
	if err := db.Model(&sys.SysApi{}).Select("path", "method").Find(&rows).Error; err == nil {
		for _, r := range rows {
			existing[key{Path: r.Path, Method: r.Method}] = struct{}{}
		}
	}
	var newApis []sys.SysApi
	for _, r := range globalRoutes {
		if _, ok := existing[key{Path: r.Path, Method: r.Method}]; ok {
			continue
		}
		newApis = append(newApis, sys.SysApi{
			Path: r.Path, Method: r.Method, Description: r.Desc, ApiGroup: r.ApiGroup,
		})
		existing[key{Path: r.Path, Method: r.Method}] = struct{}{}
	}
	if len(newApis) > 0 {
		db.CreateInBatches(newApis, 100)
	}
	globalRoutes = nil
}
