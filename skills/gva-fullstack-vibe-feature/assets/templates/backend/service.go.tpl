package {{MODULE}}

import (
	"context"

	moduleModel "{{GO_MODULE}}/model/{{MODULE}}"
	moduleReq "{{GO_MODULE}}/model/{{MODULE}}/request"
	moduleRes "{{GO_MODULE}}/model/{{MODULE}}/response"

	"go.uber.org/zap"
	"gorm.io/gorm"
)

type Service struct {
	db  *gorm.DB
	log *zap.Logger
}

func NewService(db *gorm.DB, log *zap.Logger) *Service {
	return &Service{
		db:  db,
		log: log.Named("{{MODULE}}-service"),
	}
}

func (s *Service) List(ctx context.Context, req moduleReq.List{{PASCAL}}) ([]moduleRes.Item, int64, error) {
	limit := req.PageSize
	if limit <= 0 {
		limit = 10
	}
	page := req.Page
	if page <= 0 {
		page = 1
	}
	offset := (page - 1) * limit

	db := s.db.WithContext(ctx).Model(&moduleModel.{{PASCAL}}{})

	var total int64
	if err := db.Count(&total).Error; err != nil {
		return nil, 0, err
	}

	var list []moduleRes.Item
	if err := db.Limit(limit).Offset(offset).Order("id desc").Find(&list).Error; err != nil {
		return nil, 0, err
	}

	return list, total, nil
}

func (s *Service) Create(ctx context.Context, req moduleReq.Create{{PASCAL}}) error {
	entity := moduleModel.{{PASCAL}}{
		Name: req.Name,
	}
	return s.db.WithContext(ctx).Create(&entity).Error
}

func (s *Service) Update(ctx context.Context, req moduleReq.Update{{PASCAL}}) error {
	return s.db.WithContext(ctx).Model(&moduleModel.{{PASCAL}}{}).Where("id = ?", req.ID).Updates(map[string]interface{}{
		"name": req.Name,
	}).Error
}

func (s *Service) Delete(ctx context.Context, req moduleReq.Delete{{PASCAL}}) error {
	return s.db.WithContext(ctx).Delete(&moduleModel.{{PASCAL}}{}, req.ID).Error
}
